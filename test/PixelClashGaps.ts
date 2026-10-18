import { expect } from "chai";
import { ethers, network, upgrades } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import type { Signer } from "ethers";

const GRID_SIZE = 10_000n;
const INITIAL_PIXELS = 10n;
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
  const [owner, creator, buyer, referrer] = await ethers.getSigners();
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

  const create = (tags: string[] = ["sport"], overrides: Record<string, unknown> = {}, signer: Signer = creator) =>
    pixelClash.connect(signer).createArenaWithPermit(params(overrides), tags, ...NO_PERMIT);

  const fill = (arenaId: bigint) =>
    pixelClash.connect(buyer).purchasePixelsWithPermit(arenaId, false, GRID_SIZE - INITIAL_PIXELS, ethers.ZeroAddress, ...NO_PERMIT);

  const fulfill = async (requestId: bigint, word = 0n) => {
    await network.provider.send("hardhat_mine", ["0xa"]);
    await coordinator.fulfillRandomWordsWithOverride(requestId, await wrapper.getAddress(), [word]);
  };

  return { pixelClash, arenaMethods, tagMethods, currency, creator, buyer, referrer, create, fill, fulfill };
}

describe("PixelClash", () => {
  describe("tags", () => {
    it("indexes arena tags and the global catalog with arena counts", async () => {
      const { pixelClash, create } = await loadFixture(deploy);
      expect(await pixelClash.connect((await ethers.getSigners())[1]).createArenaWithPermit.staticCall(params(), ["sport"], ...NO_PERMIT)).to.equal(1n);
      await create(["sport", "calcio-⚽"]);
      await create(["sport", "crypto"]);

      expect(await pixelClash.getArenaTags(1n)).to.deep.equal(["sport", "calcio-⚽"]);
      expect(await pixelClash.getArenaTags(2n)).to.deep.equal(["sport", "crypto"]);
      const [tags, counts, total] = await pixelClash.getTags(0n, 10n);
      expect(tags).to.deep.equal(["sport", "calcio-⚽", "crypto"]);
      expect(counts).to.deep.equal([2n, 1n, 1n]);
      expect(total).to.equal(3n);
      const [page] = await pixelClash.getTags(1n, 1n);
      expect(page).to.deep.equal(["calcio-⚽"]);
      expect(await pixelClash.getArenaCountByTag("sport")).to.equal(2n);
      expect(await pixelClash.getArenasByTag("sport", 0n, 10n)).to.deep.equal([2n, 1n]);
    });

    it("rejects non-canonical, duplicate and excess tags", async () => {
      const { tagMethods, create } = await loadFixture(deploy);
      for (const tag of ["Sport", "two words", "", "x".repeat(33), "tab\t"]) {
        await expect(create([tag])).to.be.revertedWithCustomError(tagMethods, "InvalidTag");
      }
      await expect(create(["sport", "sport"])).to.be.revertedWithCustomError(tagMethods, "InvalidTag");
      await expect(create(["a", "b", "c", "d"])).to.be.revertedWithCustomError(tagMethods, "TooManyTags");
      await expect(create(["x".repeat(32), "a", "b"])).to.not.be.reverted;
    });

    it("reverts for an invalid arena id", async () => {
      const { pixelClash } = await loadFixture(deploy);
      await expect(pixelClash.getArenaTags(1n)).to.be.revertedWithCustomError(pixelClash, "InvalidArenaId");
    });
  });

  describe("arena parameters", () => {
    it("enforces the fixed grid size and bounded fields", async () => {
      const { arenaMethods, create } = await loadFixture(deploy);
      for (const overrides of [
        { gridSize: 1_000n },
        { gridSize: 20_000n },
        { teamAName: "a".repeat(65) },
        { teamBLogo: "🔥".repeat(17) },
        { maxDuration: 365n * DAY + 1n },
      ]) {
        await expect(create([], overrides)).to.be.revertedWithCustomError(arenaMethods, "InvalidArgument");
      }
      await expect(create([], { teamAName: "a".repeat(64), maxDuration: 365n * DAY })).to.not.be.reverted;
    });
  });

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

    it("tracks active arenas until they are drawn", async () => {
      const { pixelClash, create, fill, fulfill } = await loadFixture(deploy);
      await create();
      await create();
      expect(await pixelClash.getActiveArenas(0n, 10n)).to.deep.equal([[1n, 2n], 2n]);

      await fill(1n);
      await pixelClash.draw(1n, { value: ethers.parseEther("1") });
      await fulfill((await pixelClash.getArenaData(1n)).vrfRequestId);
      expect((await pixelClash.getArenaData(1n)).state).to.equal(4n);
      expect(await pixelClash.getActiveArenas(0n, 10n)).to.deep.equal([[2n], 1n]);
    });
  });

  describe("draw recovery", () => {
    it("allows a new draw only after the retry delay and ignores the stale callback", async () => {
      const { pixelClash, create, fill, fulfill } = await loadFixture(deploy);
      await create();
      await fill(1n);
      await pixelClash.draw(1n, { value: ethers.parseEther("1") });
      const staleRequestId = (await pixelClash.getArenaData(1n)).vrfRequestId;

      await expect(pixelClash.draw(1n, { value: ethers.parseEther("1") })).to.be.revertedWithCustomError(pixelClash, "DrawPending");
      await time.increase(DAY);
      await expect(pixelClash.draw(1n, { value: ethers.parseEther("1") })).to.emit(pixelClash, "VRFRequest");
      const requestId = (await pixelClash.getArenaData(1n)).vrfRequestId;
      expect(requestId).to.not.equal(staleRequestId);
      expect(await pixelClash.arenaIdsByVrfRequestId(staleRequestId)).to.equal(0n);

      await fulfill(staleRequestId);
      expect((await pixelClash.getArenaData(1n)).state).to.equal(3n);
      await fulfill(requestId);
      expect((await pixelClash.getArenaData(1n)).state).to.equal(4n);
    });
  });

  describe("players", () => {
    it("emits referrer and fee, and exposes pixels and withdrawals per player", async () => {
      const { pixelClash, create, buyer, referrer, creator, fulfill } = await loadFixture(deploy);
      await create();
      const count = GRID_SIZE - INITIAL_PIXELS;
      const discountedFee = (PIXEL_FEE * 9n) / 10n;
      await expect(pixelClash.connect(buyer).purchasePixelsWithPermit(1n, true, count, referrer.address, ...NO_PERMIT))
        .to.emit(pixelClash, "PurchasePixels")
        .withArgs(buyer.address, 1n, true, count, count, referrer.address, discountedFee * count);
      expect(await pixelClash.getPlayerPixels(1n, buyer.address)).to.deep.equal([0n, count]);
      expect(await pixelClash.getPlayerPixels(1n, creator.address)).to.deep.equal([5n, 5n]);

      await pixelClash.draw(1n, { value: ethers.parseEther("1") });
      await fulfill((await pixelClash.getArenaData(1n)).vrfRequestId);
      const prize = await pixelClash.getPrizeFor(1n, creator.address);
      await pixelClash.connect(creator).withdrawPrize(1n);
      expect(await pixelClash.getWithdrawnPrizeAmount(1n, creator.address)).to.equal(prize);
      expect(await pixelClash.getWithdrawnPrizeAmount(1n, buyer.address)).to.equal(0n);
    });
  });
});
