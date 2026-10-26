// Pagination tests that create 100+ arenas. Run them without a mainnet fork (`npm run test:local`):
// on a fork every arena creation waits for the RPC provider, and each test takes minutes.
// Everything else is covered by PixelClash.ts.
import { expect } from "chai";
import { ethers, network, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

const GRID_SIZE = 10_000n;
const PIXEL_FEE = ethers.parseUnits("1", 18);
const DAY = 24n * 60n * 60n;
const NO_PERMIT = [0n, 0, ethers.ZeroHash, ethers.ZeroHash] as const;

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
  const [owner, creator] = await ethers.getSigners();
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

  await currency.connect(creator).mint(ethers.parseUnits("1000000", 18));
  await currency.connect(creator).approve(await pixelClash.getAddress(), ethers.MaxUint256);

  const create = (tags: string[], overrides: Record<string, unknown> = {}) =>
    pixelClash.connect(creator).createArenaWithPermit(params(overrides), tags, ...NO_PERMIT);

  return { pixelClash, create };
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

    it("keeps full pages of the largest possible arenas and tags within RPC limits", async () => {
      const { pixelClash, create } = await loadFixture(deploy);
      const name = "é".repeat(32);
      const logo = "🔥".repeat(16);
      for (let i = 0; i < 100; ++i) {
        const tags = [0, 1, 2].map((k) => `${i}-${k}`.padEnd(32, "x"));
        await create(tags, { teamAName: name, teamBName: name, teamALogo: logo, teamBLogo: logo });
      }
      // Public RPC providers commonly cap `eth_call` at 50M gas.
      expect(await pixelClash.getArenas.estimateGas(0n, 100n)).to.be.lessThan(25_000_000n);
      expect(await pixelClash.getTags.estimateGas(0n, 100n)).to.be.lessThan(25_000_000n);
    });
  });
});
