import { expect } from "chai";
import { ethers, network, upgrades } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import type { Signer } from "ethers";

const GRID_SIZE = 10_000n;
const INITIAL_PIXELS = 10n;
const PIXEL_FEE = ethers.parseUnits("1", 18);
const DAY = 24n * 60n * 60n;
const VRF_RETRY_DELAY = 6n * 60n * 60n;
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
      await time.increase(VRF_RETRY_DELAY - 10n);
      await expect(pixelClash.draw(1n, { value: ethers.parseEther("1") })).to.be.revertedWithCustomError(pixelClash, "DrawPending");
      await time.increase(10n);
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

  describe("packed indexes", () => {
    it("lists each arena once per player, newest first, and per owner", async () => {
      const { pixelClash, create, buyer, creator } = await loadFixture(deploy);
      for (let i = 0; i < 5; ++i) await create();
      for (const id of [2n, 2n, 4n, 2n, 5n]) {
        await pixelClash.connect(buyer).purchasePixelsWithPermit(id, false, 1n, ethers.ZeroAddress, ...NO_PERMIT);
      }
      expect(await pixelClash.getArenasByPlayer(buyer.address, 0n, 10n)).to.deep.equal([5n, 4n, 2n]);
      expect(await pixelClash.getArenasByPlayer(buyer.address, 1n, 1n)).to.deep.equal([4n]);
      expect(await pixelClash.getArenaCountByPlayer(buyer.address)).to.equal(3n);
      expect(await pixelClash.getUserArenas(creator.address, 0n, 10n)).to.deep.equal([5n, 4n, 3n, 2n, 1n]);
      expect(await pixelClash.getArenasByPlayer(creator.address, 0n, 2n)).to.deep.equal([5n, 4n]);
    });

    it("reuses tag IDs across arenas and keeps the order of each arena's tags", async () => {
      const { pixelClash, create, tagMethods } = await loadFixture(deploy);
      await create(["a", "b", "c"]);
      await create(["c", "a"]);
      await create([]);
      expect(await pixelClash.getArenaTags(2n)).to.deep.equal(["c", "a"]);
      expect(await pixelClash.getArenaTags(3n)).to.deep.equal([]);
      const [tags, counts, total] = await pixelClash.getTags(0n, 10n);
      expect(tags).to.deep.equal(["a", "b", "c"]);
      expect(counts).to.deep.equal([2n, 1n, 2n]);
      expect(total).to.equal(3n);
      expect(await pixelClash.getArenasByTag("c", 0n, 10n)).to.deep.equal([2n, 1n]);
      await expect(create(["b", "b"])).to.be.revertedWithCustomError(tagMethods, "InvalidTag");
    });

    it("reads packed pixel ranges for both teams and the gap", async () => {
      const { pixelClash, create, buyer, referrer, creator } = await loadFixture(deploy);
      await create();
      await pixelClash.connect(buyer).purchasePixelsWithPermit(1n, false, 100n, referrer.address, ...NO_PERMIT);
      await pixelClash.connect(buyer).purchasePixelsWithPermit(1n, true, 7n, ethers.ZeroAddress, ...NO_PERMIT);

      // `Result` is an array, so `.length` would be its number of fields: read via `toObject()`.
      const range = async (index: bigint) => {
        const [r, teamB] = await pixelClash.getPixelRange(1n, index);
        const { owner, offset, length, referrer } = r.toObject();
        return [owner, offset, length, referrer, teamB];
      };
      expect(await range(4n)).to.deep.equal([creator.address, 0n, 5n, ethers.ZeroAddress, false]);
      expect(await range(104n)).to.deep.equal([buyer.address, 5n, 100n, referrer.address, false]);
      expect(await range(GRID_SIZE - 6n)).to.deep.equal([buyer.address, 5n, 7n, ethers.ZeroAddress, true]);
      const [gap] = await pixelClash.getPixelRange(1n, 5_000n);
      expect(gap.owner).to.equal(ethers.ZeroAddress);
    });
  });

  describe("top referrers", () => {
    it("always matches a brute-force top 3 over random referrals", async () => {
      const { pixelClash, create, buyer } = await loadFixture(deploy);
      const referrers = (await ethers.getSigners()).slice(4, 14).map((signer) => signer.address);
      await create();
      const totals = new Map<string, bigint>();
      let seed = 42;
      const random = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
      for (let i = 0; i < 80; ++i) {
        const referrer = referrers[random(referrers.length)];
        const count = BigInt(1 + random(20));
        await pixelClash.connect(buyer).purchasePixelsWithPermit(1n, i % 2 === 0, count, referrer, ...NO_PERMIT);
        totals.set(referrer, (totals.get(referrer) ?? 0n) + ((PIXEL_FEE * 9n) / 10n) * count);

        const top = await pixelClash.getTopReferrers(1n);
        const expected = [...totals.values()].sort((a, b) => (b > a ? 1 : b < a ? -1 : 0)).slice(0, 3);
        // Revenues must be the 3 highest, in order; on ties any of the tied referrers is valid.
        expect(top.map((r) => r.revenue)).to.deep.equal(expected);
        for (const r of top) expect(r.revenue).to.equal(totals.get(r.referrer));
        expect(new Set(top.map((r) => r.referrer)).size).to.equal(top.length);
      }
      for (const [referrer, total] of totals) {
        expect(await pixelClash.getReferralRevenueFrom(1n, referrer)).to.equal(total);
      }
    });

    it("pays the sponsor prize to the referrer stored with the winning pixel", async () => {
      const { pixelClash, create, buyer, referrer, fulfill } = await loadFixture(deploy);
      await create();
      // Pixels 5..9994 of team A belong to the buyer, referred by `referrer`.
      await pixelClash.connect(buyer).purchasePixelsWithPermit(1n, false, GRID_SIZE - INITIAL_PIXELS, referrer.address, ...NO_PERMIT);
      await pixelClash.draw(1n, { value: ethers.parseEther("1") });
      await fulfill((await pixelClash.getArenaData(1n)).vrfRequestId, 100n);
      const [range] = await pixelClash.getPixelRange(1n, 100n);
      expect(range.referrer).to.equal(referrer.address);
      const prizes = await pixelClash.getPrizesFor(1n, referrer.address);
      const revenue = (await pixelClash.getArenaData(1n)).revenue;
      expect(prizes.sponsorPrize).to.equal((revenue * 5n) / 100n);
      expect(prizes.topReferralPrize).to.equal((revenue * 9n) / 100n);
    });
  });

  describe("referral codes", () => {
    it("registers a code once per address and resolves it", async () => {
      const { pixelClash, referrer, buyer } = await loadFixture(deploy);
      await expect(pixelClash.connect(referrer).registerReferralCode("mario_99"))
        .to.emit(pixelClash, "RegisterReferralCode")
        .withArgs(referrer.address, "mario_99");
      expect(await pixelClash.getReferralCodeOwner("mario_99")).to.equal(referrer.address);
      expect(await pixelClash.getReferralCode(referrer.address)).to.equal("mario_99");
      expect(await pixelClash.getReferralCodeOwner("nobody")).to.equal(ethers.ZeroAddress);

      await expect(pixelClash.connect(referrer).registerReferralCode("other"))
        .to.be.revertedWithCustomError(pixelClash, "ReferralCodeAlreadySet");
      await expect(pixelClash.connect(buyer).registerReferralCode("mario_99"))
        .to.be.revertedWithCustomError(pixelClash, "ReferralCodeTaken");
    });

    it("rejects codes outside the allowed charset and length", async () => {
      const { pixelClash, buyer } = await loadFixture(deploy);
      for (const code of ["ab", "a".repeat(21), "Mario", "ma rio", "mario!", "marìo", "0x"]) {
        await expect(pixelClash.connect(buyer).registerReferralCode(code))
          .to.be.revertedWithCustomError(pixelClash, "InvalidReferralCode");
      }
      await expect(pixelClash.connect(buyer).registerReferralCode("a-b_0".padEnd(20, "z"))).to.not.be.reverted;
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
      expect(await pixelClash.getPurchaseCount(1n)).to.equal(1n);
      expect(await pixelClash.getArenaCountByPlayer(buyer.address)).to.equal(1n);
      expect(await pixelClash.getArenaCountByPlayer(creator.address)).to.equal(1n);

      await pixelClash.draw(1n, { value: ethers.parseEther("1") });
      await fulfill((await pixelClash.getArenaData(1n)).vrfRequestId);
      const prize = await pixelClash.getPrizeFor(1n, creator.address);
      await pixelClash.connect(creator).withdrawPrize(1n);
      expect(await pixelClash.getWithdrawnPrizeAmount(1n, creator.address)).to.equal(prize);
      expect(await pixelClash.getWithdrawnPrizeAmount(1n, buyer.address)).to.equal(0n);
    });
  });
});
