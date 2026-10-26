// Worst-case gas tests: full pages of every paginated view and an arena with the most pixel
// ranges. They send thousands of transactions, so they run without a mainnet fork
// (`npm run test:local`): on a fork every arena creation waits for the RPC provider. There is no
// Uniswap pool here, so the swap at the end of a draw fails cheaply. Everything else is covered by
// PixelClash.ts.
import { expect } from "chai";
import { ethers, network, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

const GRID_SIZE = 10_000n;
const INITIAL_PIXELS = 10n;
const PIXEL_FEE = ethers.parseUnits("1", 18);
const DAY = 24n * 60n * 60n;
const NO_PERMIT = [0n, 0, ethers.ZeroHash, ethers.ZeroHash] as const;
// Public RPC providers commonly cap `eth_call` at 50M gas: views stay below half of it.
const VIEW_GAS_LIMIT = 25_000_000n;
// `VRF_CALLBACK_GAS_LIMIT` in PixelClash.sol.
const VRF_CALLBACK_GAS_LIMIT = 1_000_000n;

interface View {
  (...args: any[]): Promise<unknown>;
  estimateGas(...args: any[]): Promise<bigint>;
}

// Calls the view, so the gas reporter records it, and returns its gas.
async function viewGas(view: View, ...args: unknown[]): Promise<bigint> {
  await view(...args);
  return await view.estimateGas(...args);
}

const params = (overrides: Record<string, unknown> = {}) => ({
  teamAName: "Alpha",
  teamALogo: "🔥",
  teamALogoCid: ethers.ZeroHash,
  teamAColor: 0xff0000,
  teamBName: "Beta",
  teamBLogo: "💧",
  teamBLogoCid: ethers.ZeroHash,
  teamBColor: 0x0000ff,
  gridSize: GRID_SIZE,
  pixelFee: PIXEL_FEE,
  maxDuration: 7n * DAY,
  ...overrides,
});

async function deploy() {
  await network.provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x0"]);
  const [owner, creator, buyer] = await ethers.getSigners();
  const currency = await ethers.deployContract("MockToken", [18, owner.address]);
  const pixel = await ethers.deployContract("MockToken", [18, owner.address]);

  const coordinator = await ethers.deployContract("MockVRFCoordinator", [
    100_000_000_000_000_000n,
    1_000_000_000n,
    4_000_000_000_000_000n,
  ]);
  const receipt = await (await coordinator.createSubscription()).wait();
  const subscriptionId = receipt!.logs
    .map((log) => coordinator.interface.parseLog(log))
    .find((log) => log?.name === "SubscriptionCreated")!.args.subId;
  await coordinator.fundSubscriptionWithNative(subscriptionId, { value: ethers.parseEther("10") });
  const wrapper = await ethers.deployContract("MockVRFWrapper", [
    ethers.ZeroAddress,
    ethers.ZeroAddress,
    await coordinator.getAddress(),
    subscriptionId,
  ]);
  await coordinator.addConsumer(subscriptionId, await wrapper.getAddress());
  await wrapper.setConfig(60_000, 52_000, 52_000, 1_000, 0, 0, ethers.ZeroHash, 1, 3600, 4_000_000_000_000_000n, 500_000, 100_000);

  // No Uniswap here: the swap fails and the revenue stays in `protocolRevenue`.
  const gateway = await ethers.deployContract("SwapGateway", [
    await currency.getAddress(),
    await pixel.getAddress(),
    owner.address,
    owner.address,
  ]);
  const arenaMethods = await ethers.deployContract("ArenaMethods");
  const tagMethods = await ethers.deployContract("TagMethods");
  const factory = await ethers.getContractFactory("PixelClash", {
    libraries: {
      ArenaMethods: await arenaMethods.getAddress(),
      TagMethods: await tagMethods.getAddress(),
    },
  });
  const pixelClash = await upgrades.deployProxy(
    factory,
    [owner.address, await currency.getAddress(), await wrapper.getAddress(), await gateway.getAddress()],
    { kind: "uups", unsafeAllow: ["external-library-linking"] },
  );
  await gateway.transferOwnership(await pixelClash.getAddress());

  for (const signer of [creator, buyer]) {
    await currency.connect(signer).mint(ethers.parseUnits("1000000", 18));
    await currency.connect(signer).approve(await pixelClash.getAddress(), ethers.MaxUint256);
  }

  const create = (tags: string[], overrides: Record<string, unknown> = {}) =>
    pixelClash.connect(creator).createArenaWithPermit(params(overrides), tags, ...NO_PERMIT);

  const purchase = (arenaId: bigint, count: bigint, referrer = ethers.ZeroAddress) =>
    pixelClash.connect(buyer).purchasePixelsWithPermit(arenaId, false, count, referrer, ...NO_PERMIT);

  // Draws the arena and answers the VRF request; returns the gas used by the answer, which
  // includes the PixelClash callback.
  const drawAndFulfill = async (arenaId: bigint, word: bigint) => {
    await pixelClash.draw(arenaId, { value: ethers.parseEther("1") });
    const requestId = (await pixelClash.getArenaData(arenaId)).vrfRequestId;
    await network.provider.send("hardhat_mine", ["0xa"]);
    const tx = await coordinator.fulfillRandomWordsWithOverride(requestId, await wrapper.getAddress(), [word]);
    return (await tx.wait())!.gasUsed;
  };

  return { pixelClash, creator, buyer, create, purchase, drawAndFulfill };
}

describe("PixelClash", () => {
  describe("paginated views", () => {
    it("returns arenas newest first and caps the page size", async () => {
      const { pixelClash, create } = await loadFixture(deploy);
      for (let i = 0; i < 101; ++i) await create([], { teamAName: `team-${i + 1}` });

      const [ids, data] = await pixelClash.getArenas(0n, 1_000n);
      expect(ids.length).to.equal(100);
      expect(ids[0]).to.equal(101n);
      expect(data[0].teamAName).to.equal("team-101");
      const [lastIds, lastData] = await pixelClash.getArenas(100n, 10n);
      expect(lastIds).to.deep.equal([1n]);
      expect(lastData[0].teamAName).to.equal("team-1");
      const [empty] = await pixelClash.getArenas(101n, 10n);
      expect(empty).to.deep.equal([]);
    });

    it("keeps full pages of every paginated view within RPC limits", async () => {
      const { pixelClash, creator, buyer, create, purchase } = await loadFixture(deploy);
      const name = "é".repeat(32);
      const logo = "🔥".repeat(16);
      const shared = "shared".padEnd(32, "x");
      // 100 arenas of the largest size, all with `shared` among their 3 tags, by one creator and
      // all joined by one buyer: every paginated view below returns a full page.
      for (let i = 1n; i <= 100n; ++i) {
        const tags = [shared, ...[1, 2].map((k) => `${i}-${k}`.padEnd(32, "x"))];
        await create(tags, { teamAName: name, teamBName: name, teamALogo: logo, teamBLogo: logo });
        await purchase(i, 1n);
      }

      const page = [0n, 100n];
      for (const [label, gas] of [
        ["getArenas", await viewGas(pixelClash.getArenas, ...page)],
        ["getTags", await viewGas(pixelClash.getTags, ...page)],
        ["getActiveArenas", await viewGas(pixelClash.getActiveArenas, ...page)],
        ["getUserArenas", await viewGas(pixelClash.getUserArenas, creator.address, ...page)],
        ["getArenasByTag", await viewGas(pixelClash.getArenasByTag, shared, ...page)],
        ["getArenasByPlayer", await viewGas(pixelClash.getArenasByPlayer, buyer.address, ...page)],
        ["getArenaData", await viewGas(pixelClash.getArenaData, 1n)],
        ["getArenaTags", await viewGas(pixelClash.getArenaTags, 1n)],
      ] as const) {
        expect(gas, label).to.be.lessThan(VIEW_GAS_LIMIT);
      }
    });

    it("closes an arena with the most pixel ranges within the VRF callback gas limit", async function () {
      // About 10,000 purchases.
      this.timeout(600_000);
      const { pixelClash, create, purchase, drawAndFulfill } = await loadFixture(deploy);
      const referrers = (await ethers.getSigners()).slice(4, 14).map((signer) => signer.address);

      // Baseline: the whole arena bought at once, so there are only 3 ranges to search.
      await create([]);
      await purchase(1n, GRID_SIZE - INITIAL_PIXELS, referrers[0]);
      const baselineGas = await drawAndFulfill(1n, 7_777n);

      // Worst case: every pixel bought one at a time in team A, so the winner is found by a binary
      // search over 9,991 ranges, and the winning pixel has a referrer (sponsor prize).
      await create([]);
      for (let i = 0n; i < GRID_SIZE - INITIAL_PIXELS; ++i) {
        await purchase(2n, 1n, referrers[Number(i % 10n)]);
      }
      const worstGas = await drawAndFulfill(2n, 7_777n);

      // DRAWN means the callback didn't run out of gas: the coordinator doesn't revert if it does.
      for (const arenaId of [1n, 2n]) {
        expect((await pixelClash.getArenaData(arenaId)).state).to.equal(4n);
      }
      // `Result` is an array, so `.length` would be its number of fields: read via `toObject()`.
      const { length, referrer } = (await pixelClash.getPixelRange(2n, 7_777n))[0].toObject();
      expect(length).to.equal(1n);
      expect(referrer).to.not.equal(ethers.ZeroAddress);
      expect(worstGas).to.be.lessThan(VRF_CALLBACK_GAS_LIMIT);
      console.log(`      VRF answer gas: ${baselineGas} with 3 ranges, ${worstGas} with 9,991 ranges`);

      for (const [label, gas] of [
        ["getPixelRange", await viewGas(pixelClash.getPixelRange, 2n, 7_777n)],
        ["getArenaData", await viewGas(pixelClash.getArenaData, 2n)],
        ["getTopReferrers", await viewGas(pixelClash.getTopReferrers, 2n)],
        ["getAllPrizes", await viewGas(pixelClash.getAllPrizes, 2n)],
        ["getPrizesFor", await viewGas(pixelClash.getPrizesFor, 2n, referrers[0])],
      ] as const) {
        expect(gas, label).to.be.lessThan(VIEW_GAS_LIMIT);
      }
    });
  });
});
