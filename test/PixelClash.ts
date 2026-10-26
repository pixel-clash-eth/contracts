import { loadFixture, mine, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers, network } from "hardhat";
import type { BigNumberish, Signer } from "ethers";

import { Deployer } from "../scripts/deployer";

import type {
  ERC20Burnable,
  MockToken,
  MockVRFCoordinator,
  MockVRFWrapper,
  PixelClash,
  PoolCreatorHelper,
  SwapGateway,
} from "../typechain-types";

const CHAIN_LINK_BASE_FEE = 100_000_000_000_000_000n; // 0.1 LINK in juels
const CHAIN_LINK_GAS_PRICE = 1_000_000_000n; // 1 gwei
const CHAIN_LINK_WEI_PER_LINK_UNIT = 4_000_000_000_000_000n; // ~0.004 ETH/LINK

// Liquidity seeded into the MockToken / PIXEL_TOKEN pool (same wei amount for both tokens).
// At the 1:1 initialisation price (tick 0) this is more than enough to cover test revenue amounts.
const POOL_LIQUIDITY = 10n ** 18n;

const INVALID_ARENA_ID = 0;

const ONE_USDC = 1_000_000n; // 1 USDC (6 decimals, matching real USDC)
const BASE_ARENA_CREATION_FEE = 25n * ONE_USDC;
const INITIAL_PIXELS = 10n;
const ARENA_CREATION_FEE = INITIAL_PIXELS * ONE_USDC + BASE_ARENA_CREATION_FEE;

const STANDARD_GRID_SIZE = 10_000;
const STANDARD_MAX_DURATION = 3600n * 24n * 7n; // 7 days

const ARENA_STATE_OPEN = 0;
const ARENA_STATE_FULL = 1;
const ARENA_STATE_TIMED_OUT = 2;
const ARENA_STATE_DRAWING = 3;
const ARENA_STATE_DRAWN = 4;

const REFERRAL_DISCOUNT_NUMERATOR = 9n;
const REFERRAL_DISCOUNT_DENOMINATOR = 10n;

const DISCOUNTED_PIXEL_FEE =
  (ONE_USDC * REFERRAL_DISCOUNT_NUMERATOR) / REFERRAL_DISCOUNT_DENOMINATOR;

const MAX_DURATION = 3600n * 24n * 365n;
const VRF_RETRY_DELAY = 3600n * 6n;

function arenaParams(overrides: Record<string, unknown> = {}) {
  return {
    teamAName: "Dogs",
    teamALogo: "\u{1F436}",
    teamALogoCid: ethers.ZeroHash,
    teamAColor: 0xff0000,
    teamBName: "Cats",
    teamBLogo: "\u{1F431}",
    teamBLogoCid: ethers.ZeroHash,
    teamBColor: 0x0000ff,
    gridSize: STANDARD_GRID_SIZE,
    pixelFee: ONE_USDC,
    maxDuration: STANDARD_MAX_DURATION,
    ...overrides,
  };
}

class Fixture {
  private static async _deploy(): Promise<Fixture> {
    // The fee estimate can lag behind the base fee of the next forked block and get rejected.
    await network.provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x0"]);
    const [owner, creator, player1, player2] = await ethers.getSigners();
    const deployer = await Deployer.create();

    const currencyToken = await deployer.deploy<MockToken>(
      "MockToken",
      /*decimals=*/ 6,
      owner.address,
    );

    const pixelToken = await deployer.deploy<MockToken>(
      "MockToken",
      /*decimals=*/ 18,
      owner.address,
    );

    const mockVrfCoordinator = await deployer.deploy<MockVRFCoordinator>(
      "MockVRFCoordinator",
      CHAIN_LINK_BASE_FEE,
      CHAIN_LINK_GAS_PRICE,
      CHAIN_LINK_WEI_PER_LINK_UNIT,
    );
    await mockVrfCoordinator.waitForDeployment();

    const subscriptionId = await (async () => {
      const transaction = await mockVrfCoordinator.createSubscription();
      const createReceipt = await transaction.wait();
      const createLog = createReceipt!.logs
        .map((log) => {
          try {
            return mockVrfCoordinator.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((log) => log?.name === "SubscriptionCreated")!;
      return createLog.args.subId;
    })();
    await mockVrfCoordinator.fundSubscriptionWithNative(subscriptionId, {
      value: ethers.parseEther("10"),
    });

    const mockVRFWrapper = await deployer.deploy<MockVRFWrapper>(
      "MockVRFWrapper",
      /*link=*/ ethers.ZeroAddress,
      /*linkNativeFeed=*/ ethers.ZeroAddress,
      await mockVrfCoordinator.getAddress(),
      subscriptionId,
    );
    await mockVRFWrapper.waitForDeployment();

    await mockVrfCoordinator.addConsumer(subscriptionId, await mockVRFWrapper.getAddress());

    // Configure the wrapper so that price calculations and randomness requests work.
    await mockVRFWrapper.setConfig(
      /*wrapperGasOverhead=*/ 60_000,
      /*coordinatorGasOverheadNative=*/ 52_000,
      /*coordinatorGasOverheadLink=*/ 52_000,
      /*coordinatorGasOverheadPerWord=*/ 1_000,
      /*coordinatorNativePremiumPercentage=*/ 0,
      /*coordinatorLinkPremiumPercentage=*/ 0,
      /*keyHash=*/ ethers.ZeroHash,
      /*maxNumWords=*/ 1,
      /*stalenessSeconds=*/ 3600,
      /*fallbackWeiPerUnitLink=*/ CHAIN_LINK_WEI_PER_LINK_UNIT,
      /*fulfillmentFlatFeeNativePPM=*/ 500_000,
      /*fulfillmentFlatFeeLinkDiscountPPM=*/ 100_000,
    );

    // ── Create Uniswap V3 pool (currencyToken ↔ pixelToken, 0.05 % fee tier) ──
    const currencyTokenAddress = await currencyToken.getAddress();
    const pixelTokenAddress = await pixelToken.getAddress();

    await currencyToken.connect(owner).mint(POOL_LIQUIDITY);
    await pixelToken.connect(owner).mint(POOL_LIQUIDITY);

    const poolHelper = await deployer.deploy<PoolCreatorHelper>(
      "PoolCreatorHelper",
      process.env.UNISWAP_V3_FACTORY!,
      process.env.UNISWAP_V3_POSITION_MANAGER!,
    );
    await currencyToken.connect(owner).approve(await poolHelper.getAddress(), POOL_LIQUIDITY);
    await pixelToken.connect(owner).approve(await poolHelper.getAddress(), POOL_LIQUIDITY);
    await poolHelper
      .connect(owner)
      .createAndSeed(
        currencyTokenAddress,
        pixelTokenAddress,
        parseInt(process.env.UNISWAP_V3_POOL_FEE!, 10),
        POOL_LIQUIDITY,
      );

    // Fast-forward 30 min + 1 s so SwapGateway's pool.observe([1800, 0]) has enough history.
    await time.increase(1801);

    process.env.OWNER_ADDRESS = owner.address;
    process.env.CURRENCY_TOKEN = currencyTokenAddress;
    process.env.PIXEL_TOKEN = pixelTokenAddress;
    process.env.CHAIN_LINK_VRF_WRAPPER = await mockVRFWrapper.getAddress();

    const pixelClash = await deployer.deployPixelClash();
    const swapGateway = await ethers.getContractAt("SwapGateway", await pixelClash.swapGateway());

    const uniswapFactory = new ethers.Contract(
      process.env.UNISWAP_V3_FACTORY!,
      ["function getPool(address,address,uint24) view returns (address)"],
      ethers.provider,
    );
    const swapPoolAddress: string = await uniswapFactory.getPool(
      currencyTokenAddress,
      pixelTokenAddress,
      parseInt(process.env.UNISWAP_V3_POOL_FEE!, 10),
    );

    return new Fixture(
      owner,
      [creator, player1, player2],
      mockVrfCoordinator,
      subscriptionId,
      currencyToken,
      pixelToken,
      pixelClash,
      swapGateway,
      swapPoolAddress,
    );
  }

  public static async load(): Promise<Fixture> {
    return await loadFixture(Fixture._deploy);
  }

  private constructor(
    private readonly _owner: Signer,
    private readonly _accounts: Signer[],
    private readonly _mockVrfCoordinator: MockVRFCoordinator,
    private readonly _subscriptionId: number,
    private readonly _currencyToken: MockToken,
    private readonly _pixelToken: ERC20Burnable,
    private readonly _pixelClash: PixelClash,
    private readonly _swapGateway: SwapGateway,
    private readonly _swapPoolAddress: string,
  ) {}

  get owner() {
    return this._owner;
  }

  get creator() {
    return this._accounts[0];
  }

  get player1() {
    return this._accounts[1];
  }

  get player2() {
    return this._accounts[2];
  }

  get mockVrfCoordinator() {
    return this._mockVrfCoordinator;
  }

  get subscriptionId() {
    return this._subscriptionId;
  }

  get currencyToken() {
    return this._currencyToken;
  }

  get pixelToken() {
    return this._pixelToken;
  }

  get pixelClash() {
    return this._pixelClash;
  }

  get swapGateway() {
    return this._swapGateway;
  }

  get swapPoolAddress() {
    return this._swapPoolAddress;
  }

  public async createTestArena(): Promise<void> {
    await this.createArena(["animals", "dogs", "cats"]);
  }

  public async createArena(tags: string[], overrides: Record<string, unknown> = {}) {
    const { creator } = this;

    await this._currencyToken.connect(creator).mint(ARENA_CREATION_FEE);
    await this._currencyToken
      .connect(creator)
      .approve(await this._pixelClash.getAddress(), ARENA_CREATION_FEE);

    return await this._pixelClash
      .connect(creator)
      .createArenaWithPermit(
        arenaParams(overrides),
        tags,
        ethers.MaxUint256,
        0,
        ethers.ZeroHash,
        ethers.ZeroHash,
      );
  }

  // Mints `amount` currency tokens to `player` and lets PixelClash spend all of them.
  public async fund(player: Signer, amount: bigint): Promise<void> {
    await this._currencyToken.connect(player).mint(amount);
    await this._currencyToken
      .connect(player)
      .approve(await this._pixelClash.getAddress(), ethers.MaxUint256);
  }

  // player1 buys all the team A pixels left in a fresh arena, without a referrer.
  public async fill(arenaId: number): Promise<void> {
    const count = BigInt(STANDARD_GRID_SIZE) - INITIAL_PIXELS;
    await this.fund(this.player1, ONE_USDC * count);
    await this.purchasePixels(this.player1, arenaId, false, count, null);
  }

  public async fulfill(vrfRequestId: bigint, randomWord: bigint = 0n): Promise<void> {
    await mine(10);
    const vrfConsumer = await ethers.getContractAt("VRFConsumer", await this._pixelClash.vrfConsumer());
    await this._mockVrfCoordinator.fulfillRandomWordsWithOverride(
      vrfRequestId,
      await vrfConsumer.i_vrfV2PlusWrapper(),
      [randomWord],
    );
  }

  public async purchasePixels(
    player: Signer,
    arenaId: number,
    teamB: boolean,
    count: BigNumberish,
    referral: Signer | null,
  ): Promise<void> {
    await this._pixelClash
      .connect(player)
      .purchasePixelsWithPermit(
        arenaId,
        teamB,
        count,
        referral ? await referral.getAddress() : ethers.ZeroAddress,
        ethers.MaxUint256,
        0,
        ethers.ZeroHash,
        ethers.ZeroHash,
      );
  }
}

describe("PixelClash", function () {
  it("initial state", async function () {
    const { owner, creator, currencyToken, pixelToken, pixelClash, swapGateway, swapPoolAddress } =
      await Fixture.load();
    const ownerAddress = await owner.getAddress();
    expect(await pixelClash.hasRole(await pixelClash.DEFAULT_ADMIN_ROLE(), ownerAddress)).to.be
      .true;
    expect(await pixelClash.hasRole(await pixelClash.UPGRADE_ROLE(), ownerAddress)).to.be.true;
    expect(await pixelClash.hasRole(await pixelClash.PAUSE_ROLE(), ownerAddress)).to.be.true;
    expect(await pixelClash.hasRole(await pixelClash.CONFIG_ROLE(), ownerAddress)).to.be.true;
    expect(await pixelClash.paused()).to.be.false;
    expect(await pixelClash.currencyToken()).to.equal(await currencyToken.getAddress());
    expect(await pixelClash.vrfConsumer()).to.not.equal(ethers.ZeroAddress);
    expect(await pixelClash.arenaCreationFee(ONE_USDC)).to.equal(ARENA_CREATION_FEE);
    await expect(pixelClash.getArenaData(INVALID_ARENA_ID)).to.be.revertedWithCustomError(
      pixelClash,
      "InvalidArenaId",
    );
    await expect(pixelClash.getArenaData(1)).to.be.revertedWithCustomError(
      pixelClash,
      "InvalidArenaId",
    );
    expect(await pixelClash.getArenaCount()).to.equal(0);
    expect(await pixelClash.getArenasByTag("animals", 0, 10)).to.deep.equal([]);
    expect(await pixelClash.getArenasByTag("dogs", 0, 10)).to.deep.equal([]);
    expect(await pixelClash.getUserArenas(await owner.getAddress(), 0, 10)).to.deep.equal([]);
    expect(await pixelClash.getUserArenas(await creator.getAddress(), 0, 10)).to.deep.equal([]);
    expect(await swapGateway.inputToken()).to.equal(await currencyToken.getAddress());
    expect(await swapGateway.targetToken()).to.equal(await pixelToken.getAddress());
    expect(await swapGateway.swapRouter()).to.equal(process.env.UNISWAP_V3_ROUTER);
    expect(await swapGateway.swapPool()).to.equal(swapPoolAddress);
  });

  it("create arena", async function () {
    const { creator, currencyToken, pixelClash } = await Fixture.load();

    await currencyToken.connect(creator).mint(ARENA_CREATION_FEE);
    await currencyToken.connect(creator).approve(await pixelClash.getAddress(), ARENA_CREATION_FEE);

    const pixelFee = ONE_USDC;
    const params = {
      teamAName: "Dogs",
      teamALogo: "\u{1F436}",
      teamALogoCid: ethers.ZeroHash,
      teamAColor: 0xff0000,
      teamBName: "Cats",
      teamBLogo: "\u{1F431}",
      teamBLogoCid: ethers.ZeroHash,
      teamBColor: 0x0000ff,
      gridSize: STANDARD_GRID_SIZE,
      pixelFee,
      maxDuration: STANDARD_MAX_DURATION,
    };

    await pixelClash
      .connect(creator)
      .createArenaWithPermit(
        params,
        ["animals", "dogs", "cats"],
        ethers.MaxUint256,
        0,
        ethers.ZeroHash,
        ethers.ZeroHash,
      );

    const arenaData = await pixelClash.getArenaData(1);
    expect(arenaData.owner).to.equal(await creator.getAddress());
    expect(arenaData.teamAName).to.equal(params.teamAName);
    expect(arenaData.teamBName).to.equal(params.teamBName);
    expect(arenaData.gridSize).to.equal(STANDARD_GRID_SIZE);
    expect(arenaData.pixelFee).to.equal(pixelFee);
    expect(arenaData.maxDuration).to.equal(STANDARD_MAX_DURATION);
    expect(arenaData.state).to.equal(ARENA_STATE_OPEN);
    expect(arenaData.winner).to.equal(-1n);
    expect(arenaData.creationTimestamp).to.be.greaterThan(0n);
    expect(arenaData.revenue).to.equal(0);
    expect(arenaData.balance).to.equal(0);

    const numPixelsPerTeam = INITIAL_PIXELS / 2n;
    expect(arenaData.teamACount).to.equal(numPixelsPerTeam);
    expect(arenaData.teamBCount).to.equal(numPixelsPerTeam);

    expect(await pixelClash.protocolRevenue()).to.equal(ARENA_CREATION_FEE);

    expect(await pixelClash.getArenaCount()).to.equal(1);
    expect(await pixelClash.getArenasByTag("animals", 0, 10)).to.deep.equal([1n]);
    expect(await pixelClash.getArenasByTag("dogs", 0, 10)).to.deep.equal([1n]);
    expect(await pixelClash.getArenasByTag("cats", 0, 10)).to.deep.equal([1n]);
    expect(await pixelClash.getArenasByTag("unknown", 0, 10)).to.deep.equal([]);
    expect(await pixelClash.getArenasByTag("animals", 1, 10)).to.deep.equal([]);
    expect(await pixelClash.getArenasByTag("animals", 0, 0)).to.deep.equal([]);

    const creatorAddress = await creator.getAddress();
    expect(await pixelClash.getUserArenas(creatorAddress, 0, 10)).to.deep.equal([1n]);
    expect(await pixelClash.getUserArenas(creatorAddress, 1, 10)).to.deep.equal([]);
    expect(await pixelClash.getUserArenas(creatorAddress, 0, 0)).to.deep.equal([]);
    expect(await pixelClash.getUserArenas(ethers.ZeroAddress, 0, 10)).to.deep.equal([]);
  });

  it("getUserArenas paging", async function () {
    const { creator, pixelClash, currencyToken } = await Fixture.load();
    const creatorAddress = await creator.getAddress();

    const pixelFee = ONE_USDC;
    const params = {
      teamAName: "Dogs",
      teamALogo: "\u{1F436}",
      teamALogoCid: ethers.ZeroHash,
      teamAColor: 0xff0000,
      teamBName: "Cats",
      teamBLogo: "\u{1F431}",
      teamBLogoCid: ethers.ZeroHash,
      teamBColor: 0x0000ff,
      gridSize: STANDARD_GRID_SIZE,
      pixelFee,
      maxDuration: STANDARD_MAX_DURATION,
    };
    for (let i = 0; i < 3; ++i) {
      await currencyToken.connect(creator).mint(ARENA_CREATION_FEE);
      await currencyToken
        .connect(creator)
        .approve(await pixelClash.getAddress(), ARENA_CREATION_FEE);
      await pixelClash
        .connect(creator)
        .createArenaWithPermit(params, [], ethers.MaxUint256, 0, ethers.ZeroHash, ethers.ZeroHash);
    }

    expect(await pixelClash.getArenaCount()).to.equal(3);
    expect(await pixelClash.getUserArenas(creatorAddress, 0, 10)).to.deep.equal([3n, 2n, 1n]);
    expect(await pixelClash.getUserArenas(creatorAddress, 0, 2)).to.deep.equal([3n, 2n]);
    expect(await pixelClash.getUserArenas(creatorAddress, 1, 2)).to.deep.equal([2n, 1n]);
    expect(await pixelClash.getUserArenas(creatorAddress, 2, 10)).to.deep.equal([1n]);
    expect(await pixelClash.getUserArenas(creatorAddress, 3, 10)).to.deep.equal([]);
    expect(await pixelClash.getUserArenas(creatorAddress, 0, 0)).to.deep.equal([]);
  });

  it("getUserArenas - lists are isolated per owner", async function () {
    const fixture = await Fixture.load();
    const { creator, player1, currencyToken, pixelClash } = fixture;
    const creatorAddress = await creator.getAddress();
    const player1Address = await player1.getAddress();

    const params = {
      teamAName: "Dogs",
      teamALogo: "\u{1F436}",
      teamALogoCid: ethers.ZeroHash,
      teamAColor: 0xff0000,
      teamBName: "Cats",
      teamBLogo: "\u{1F431}",
      teamBLogoCid: ethers.ZeroHash,
      teamBColor: 0x0000ff,
      gridSize: STANDARD_GRID_SIZE,
      pixelFee: ONE_USDC,
      maxDuration: STANDARD_MAX_DURATION,
    };

    // creator creates arenas 1 and 2
    for (let i = 0; i < 2; ++i) {
      await currencyToken.connect(creator).mint(ARENA_CREATION_FEE);
      await currencyToken
        .connect(creator)
        .approve(await pixelClash.getAddress(), ARENA_CREATION_FEE);
      await pixelClash
        .connect(creator)
        .createArenaWithPermit(params, [], ethers.MaxUint256, 0, ethers.ZeroHash, ethers.ZeroHash);
    }

    // player1 creates arena 3
    await currencyToken.connect(player1).mint(ARENA_CREATION_FEE);
    await currencyToken.connect(player1).approve(await pixelClash.getAddress(), ARENA_CREATION_FEE);
    await pixelClash
      .connect(player1)
      .createArenaWithPermit(params, [], ethers.MaxUint256, 0, ethers.ZeroHash, ethers.ZeroHash);

    expect(await pixelClash.getArenaCount()).to.equal(3);
    expect(await pixelClash.getUserArenas(creatorAddress, 0, 10)).to.deep.equal([2n, 1n]);
    expect(await pixelClash.getUserArenas(player1Address, 0, 10)).to.deep.equal([3n]);
    expect(await pixelClash.getUserArenas(ethers.ZeroAddress, 0, 10)).to.deep.equal([]);
  });

  it("getArenasByTag - paging across multiple arenas", async function () {
    const fixture = await Fixture.load();

    // createTestArena tags each arena with ["animals", "dogs", "cats"]
    await fixture.createTestArena(); // arena 1
    await fixture.createTestArena(); // arena 2
    await fixture.createTestArena(); // arena 3

    const { pixelClash } = fixture;
    expect(await pixelClash.getArenasByTag("animals", 0, 10)).to.deep.equal([3n, 2n, 1n]);
    expect(await pixelClash.getArenasByTag("animals", 0, 2)).to.deep.equal([3n, 2n]);
    expect(await pixelClash.getArenasByTag("animals", 1, 2)).to.deep.equal([2n, 1n]);
    expect(await pixelClash.getArenasByTag("animals", 2, 10)).to.deep.equal([1n]);
    expect(await pixelClash.getArenasByTag("animals", 3, 10)).to.deep.equal([]);
    expect(await pixelClash.getArenasByTag("animals", 0, 0)).to.deep.equal([]);
  });

  it("getArenasByTag - tag specificity", async function () {
    const fixture = await Fixture.load();
    const { creator, currencyToken, pixelClash } = fixture;

    const params = {
      teamAName: "Dogs",
      teamALogo: "\u{1F436}",
      teamALogoCid: ethers.ZeroHash,
      teamAColor: 0xff0000,
      teamBName: "Cats",
      teamBLogo: "\u{1F431}",
      teamBLogoCid: ethers.ZeroHash,
      teamBColor: 0x0000ff,
      gridSize: STANDARD_GRID_SIZE,
      pixelFee: ONE_USDC,
      maxDuration: STANDARD_MAX_DURATION,
    };

    const createArena = async (tags: string[]) => {
      await currencyToken.connect(creator).mint(ARENA_CREATION_FEE);
      await currencyToken
        .connect(creator)
        .approve(await pixelClash.getAddress(), ARENA_CREATION_FEE);
      await pixelClash
        .connect(creator)
        .createArenaWithPermit(
          params,
          tags,
          ethers.MaxUint256,
          0,
          ethers.ZeroHash,
          ethers.ZeroHash,
        );
    };

    await createArena(["sport", "football"]); // arena 1
    await createArena(["sport", "basketball"]); // arena 2
    await createArena([]); // arena 3 — untagged

    expect(await pixelClash.getArenasByTag("sport", 0, 10)).to.deep.equal([2n, 1n]);
    expect(await pixelClash.getArenasByTag("football", 0, 10)).to.deep.equal([1n]);
    expect(await pixelClash.getArenasByTag("basketball", 0, 10)).to.deep.equal([2n]);
    expect(await pixelClash.getArenasByTag("unknown", 0, 10)).to.deep.equal([]);
    // untagged arena 3 appears in no tag lists
    expect(await pixelClash.getArenasByTag("sport", 0, 10)).to.not.include(3n);
  });

  it("getArenasByPlayer - empty for non-participant", async function () {
    const { player1, pixelClash } = await Fixture.load();
    const player1Address = await player1.getAddress();
    expect(await pixelClash.getArenasByPlayer(player1Address, 0, 10)).to.deep.equal([]);
    expect(await pixelClash.getArenasByPlayer(ethers.ZeroAddress, 0, 10)).to.deep.equal([]);
  });

  it("getArenasByPlayer - creator tracked on arena creation", async function () {
    const fixture = await Fixture.load();
    await fixture.createTestArena();

    const { creator, pixelClash } = fixture;
    const creatorAddress = await creator.getAddress();
    expect(await pixelClash.getArenasByPlayer(creatorAddress, 0, 10)).to.deep.equal([1n]);
  });

  it("getArenasByPlayer - player tracked after first purchase", async function () {
    const fixture = await Fixture.load();
    await fixture.createTestArena();

    const { player1, currencyToken, pixelClash } = fixture;
    const player1Address = await player1.getAddress();

    await currencyToken.connect(player1).mint(ONE_USDC);
    await currencyToken.connect(player1).approve(await pixelClash.getAddress(), ONE_USDC);
    await fixture.purchasePixels(player1, 1, false, 1, null);

    expect(await pixelClash.getArenasByPlayer(player1Address, 0, 10)).to.deep.equal([1n]);
  });

  it("getArenasByPlayer - no duplicates from multiple purchases in same arena", async function () {
    const fixture = await Fixture.load();
    await fixture.createTestArena();

    const { player1, currencyToken, pixelClash } = fixture;
    const player1Address = await player1.getAddress();

    await currencyToken.connect(player1).mint(ONE_USDC * 2n);
    await currencyToken.connect(player1).approve(await pixelClash.getAddress(), ONE_USDC * 2n);
    await fixture.purchasePixels(player1, 1, false, 1, null);
    await fixture.purchasePixels(player1, 1, true, 1, null);

    expect(await pixelClash.getArenasByPlayer(player1Address, 0, 10)).to.deep.equal([1n]);
  });

  it("getArenasByPlayer - creator not duplicated when also purchasing in own arena", async function () {
    const fixture = await Fixture.load();
    await fixture.createTestArena();

    const { creator, currencyToken, pixelClash } = fixture;
    const creatorAddress = await creator.getAddress();

    await currencyToken.connect(creator).mint(ONE_USDC);
    await currencyToken.connect(creator).approve(await pixelClash.getAddress(), ONE_USDC);
    await fixture.purchasePixels(creator, 1, false, 1, null);

    expect(await pixelClash.getArenasByPlayer(creatorAddress, 0, 10)).to.deep.equal([1n]);
  });

  it("getArenasByPlayer - paging across multiple arenas", async function () {
    const fixture = await Fixture.load();
    const { player1, currencyToken, pixelClash } = fixture;
    const player1Address = await player1.getAddress();

    for (let i = 0; i < 3; ++i) {
      await fixture.createTestArena();
      await currencyToken.connect(player1).mint(ONE_USDC);
      await currencyToken.connect(player1).approve(await pixelClash.getAddress(), ONE_USDC);
      await fixture.purchasePixels(player1, i + 1, false, 1, null);
    }

    expect(await pixelClash.getArenasByPlayer(player1Address, 0, 10)).to.deep.equal([3n, 2n, 1n]);
    expect(await pixelClash.getArenasByPlayer(player1Address, 0, 2)).to.deep.equal([3n, 2n]);
    expect(await pixelClash.getArenasByPlayer(player1Address, 1, 2)).to.deep.equal([2n, 1n]);
    expect(await pixelClash.getArenasByPlayer(player1Address, 2, 10)).to.deep.equal([1n]);
    expect(await pixelClash.getArenasByPlayer(player1Address, 3, 10)).to.deep.equal([]);
    expect(await pixelClash.getArenasByPlayer(player1Address, 0, 0)).to.deep.equal([]);
  });

  it("purchase pixel in team A", async function () {
    const fixture = await Fixture.load();
    await fixture.createTestArena();

    const { player1: player, currencyToken, pixelClash } = fixture;
    await currencyToken.connect(player).mint(ONE_USDC);
    await currencyToken.connect(player).approve(await pixelClash.getAddress(), ONE_USDC);

    const arenaId = 1;
    const teamB = false;
    await fixture.purchasePixels(player, arenaId, teamB, 1, null);
    expect(await currencyToken.balanceOf(await player.getAddress())).to.equal(0n);

    const arenaData = await pixelClash.getArenaData(arenaId);
    expect(arenaData.state).to.equal(ARENA_STATE_OPEN);
    expect(arenaData.revenue).to.equal(ONE_USDC);
    expect(arenaData.balance).to.equal(ONE_USDC);

    const numPixelsPerTeamFromCreation = INITIAL_PIXELS / 2n;
    expect(arenaData.teamACount).to.equal(numPixelsPerTeamFromCreation + 1n);
    expect(arenaData.teamBCount).to.equal(numPixelsPerTeamFromCreation);

    expect(await pixelClash.protocolRevenue()).to.equal(ARENA_CREATION_FEE);
  });

  it("purchase pixel in team B", async function () {
    const fixture = await Fixture.load();
    await fixture.createTestArena();

    const { player1: player, currencyToken, pixelClash } = fixture;
    await currencyToken.connect(player).mint(ONE_USDC);
    await currencyToken.connect(player).approve(await pixelClash.getAddress(), ONE_USDC);

    const arenaId = 1;
    const teamB = true;
    await fixture.purchasePixels(player, arenaId, teamB, 1, null);
    expect(await currencyToken.balanceOf(await player.getAddress())).to.equal(0n);

    const arenaData = await pixelClash.getArenaData(arenaId);
    expect(arenaData.state).to.equal(ARENA_STATE_OPEN);
    expect(arenaData.revenue).to.equal(ONE_USDC);
    expect(arenaData.balance).to.equal(ONE_USDC);

    const numPixelsPerTeamFromCreation = INITIAL_PIXELS / 2n;
    expect(arenaData.teamACount).to.equal(numPixelsPerTeamFromCreation);
    expect(arenaData.teamBCount).to.equal(numPixelsPerTeamFromCreation + 1n);

    expect(await pixelClash.protocolRevenue()).to.equal(ARENA_CREATION_FEE);
  });

  it("purchase pixels in team A", async function () {
    const fixture = await Fixture.load();
    await fixture.createTestArena();

    const { player1: player, currencyToken, pixelClash } = fixture;
    await currencyToken.connect(player).mint(ONE_USDC * 2n);
    await currencyToken.connect(player).approve(await pixelClash.getAddress(), ONE_USDC * 2n);

    const arenaId = 1;
    const teamB = false;
    await fixture.purchasePixels(player, arenaId, teamB, 2, null);
    expect(await currencyToken.balanceOf(await player.getAddress())).to.equal(0n);

    const arenaData = await pixelClash.getArenaData(arenaId);
    expect(arenaData.state).to.equal(ARENA_STATE_OPEN);
    expect(arenaData.revenue).to.equal(ONE_USDC * 2n);
    expect(arenaData.balance).to.equal(ONE_USDC * 2n);

    const numPixelsPerTeamFromCreation = INITIAL_PIXELS / 2n;
    expect(arenaData.teamACount).to.equal(numPixelsPerTeamFromCreation + 2n);
    expect(arenaData.teamBCount).to.equal(numPixelsPerTeamFromCreation);

    expect(await pixelClash.protocolRevenue()).to.equal(ARENA_CREATION_FEE);
  });

  it("purchase pixels in team B", async function () {
    const fixture = await Fixture.load();
    await fixture.createTestArena();

    const { player1: player, currencyToken, pixelClash } = fixture;
    await currencyToken.connect(player).mint(ONE_USDC * 2n);
    await currencyToken.connect(player).approve(await pixelClash.getAddress(), ONE_USDC * 2n);

    const arenaId = 1;
    const teamB = true;
    await fixture.purchasePixels(player, arenaId, teamB, 2, null);
    expect(await currencyToken.balanceOf(await player.getAddress())).to.equal(0n);

    const arenaData = await pixelClash.getArenaData(arenaId);
    expect(arenaData.state).to.equal(ARENA_STATE_OPEN);
    expect(arenaData.revenue).to.equal(ONE_USDC * 2n);
    expect(arenaData.balance).to.equal(ONE_USDC * 2n);

    const numPixelsPerTeamFromCreation = INITIAL_PIXELS / 2n;
    expect(arenaData.teamACount).to.equal(numPixelsPerTeamFromCreation);
    expect(arenaData.teamBCount).to.equal(numPixelsPerTeamFromCreation + 2n);

    expect(await pixelClash.protocolRevenue()).to.equal(ARENA_CREATION_FEE);
  });

  it("player1 purchases from team A and player2 from team B", async function () {
    const fixture = await Fixture.load();
    await fixture.createTestArena();

    const { player1, player2, currencyToken, pixelClash } = fixture;
    const arenaId = 1;
    const player1PixelCount = 12n;
    const player2PixelCount = 34n;
    const player1Cost = ONE_USDC * player1PixelCount;
    const player2Cost = ONE_USDC * player2PixelCount;

    await currencyToken.connect(player1).mint(player1Cost);
    await currencyToken.connect(player1).approve(await pixelClash.getAddress(), player1Cost);

    await currencyToken.connect(player2).mint(player2Cost);
    await currencyToken.connect(player2).approve(await pixelClash.getAddress(), player2Cost);

    await fixture.purchasePixels(
      player1,
      arenaId,
      /*teamB=*/ false,
      player1PixelCount,
      /*referrer=*/ null,
    );
    await fixture.purchasePixels(
      player2,
      arenaId,
      /*teamB=*/ true,
      player2PixelCount,
      /*referrer=*/ null,
    );

    expect(await currencyToken.balanceOf(await player1.getAddress())).to.equal(0n);
    expect(await currencyToken.balanceOf(await player2.getAddress())).to.equal(0n);

    const arenaData = await pixelClash.getArenaData(arenaId);
    expect(arenaData.state).to.equal(ARENA_STATE_OPEN);
    expect(arenaData.revenue).to.equal(ONE_USDC * 46n);
    expect(arenaData.balance).to.equal(ONE_USDC * 46n);

    const numPixelsPerTeamFromCreation = INITIAL_PIXELS / 2n;
    expect(arenaData.teamACount).to.equal(numPixelsPerTeamFromCreation + player1PixelCount);
    expect(arenaData.teamBCount).to.equal(numPixelsPerTeamFromCreation + player2PixelCount);

    expect(await pixelClash.protocolRevenue()).to.equal(ARENA_CREATION_FEE);
  });

  it("purchase all remaining pixels in team A", async function () {
    const fixture = await Fixture.load();
    await fixture.createTestArena();

    const { player1: player, currencyToken, pixelClash } = fixture;
    const arenaId = 1;
    const pixelFee = ONE_USDC;
    const numPixelsPerTeamFromCreation = INITIAL_PIXELS / 2n;
    const pixelsAlreadyFilled = numPixelsPerTeamFromCreation * 2n;
    const gridSize = BigInt(STANDARD_GRID_SIZE);
    const remainingPixels = gridSize - pixelsAlreadyFilled;
    const totalCost = pixelFee * remainingPixels;

    await currencyToken.connect(player).mint(totalCost);
    await currencyToken.connect(player).approve(await pixelClash.getAddress(), totalCost);

    await fixture.purchasePixels(
      player,
      arenaId,
      /*teamB=*/ false,
      remainingPixels,
      /*referrer=*/ null,
    );

    expect(await currencyToken.balanceOf(await player.getAddress())).to.equal(0n);

    const arenaData = await pixelClash.getArenaData(arenaId);
    expect(arenaData.state).to.equal(ARENA_STATE_FULL);
    expect(arenaData.teamACount).to.equal(numPixelsPerTeamFromCreation + remainingPixels);
    expect(arenaData.teamBCount).to.equal(numPixelsPerTeamFromCreation);
    expect(arenaData.teamACount + arenaData.teamBCount).to.equal(gridSize);
    expect(arenaData.revenue).to.equal(totalCost);
    expect(arenaData.balance).to.equal(totalCost);
  });

  it("purchase all remaining pixels in team B", async function () {
    const fixture = await Fixture.load();
    await fixture.createTestArena();

    const { player1: player, currencyToken, pixelClash } = fixture;
    const arenaId = 1;
    const pixelFee = ONE_USDC;
    const numPixelsPerTeamFromCreation = INITIAL_PIXELS / 2n;
    const pixelsAlreadyFilled = numPixelsPerTeamFromCreation * 2n;
    const gridSize = BigInt(STANDARD_GRID_SIZE);
    const remainingPixels = gridSize - pixelsAlreadyFilled;
    const totalCost = pixelFee * remainingPixels;

    await currencyToken.connect(player).mint(totalCost);
    await currencyToken.connect(player).approve(await pixelClash.getAddress(), totalCost);

    await fixture.purchasePixels(
      player,
      arenaId,
      /*teamB=*/ true,
      remainingPixels,
      /*referrer=*/ null,
    );

    expect(await currencyToken.balanceOf(await player.getAddress())).to.equal(0n);

    const arenaData = await pixelClash.getArenaData(arenaId);
    expect(arenaData.state).to.equal(ARENA_STATE_FULL);
    expect(arenaData.teamACount).to.equal(numPixelsPerTeamFromCreation);
    expect(arenaData.teamBCount).to.equal(numPixelsPerTeamFromCreation + remainingPixels);
    expect(arenaData.teamACount + arenaData.teamBCount).to.equal(gridSize);
    expect(arenaData.revenue).to.equal(totalCost);
    expect(arenaData.balance).to.equal(totalCost);
  });

  it("player1 and player2 together fill the arena", async function () {
    const fixture = await Fixture.load();
    await fixture.createTestArena();

    const { player1, player2, currencyToken, pixelClash } = fixture;
    const arenaId = 1;
    const pixelFee = ONE_USDC;
    const numPixelsPerTeamFromCreation = INITIAL_PIXELS / 2n;
    const pixelsAlreadyFilled = numPixelsPerTeamFromCreation * 2n;
    const gridSize = BigInt(STANDARD_GRID_SIZE);
    const remainingPixels = gridSize - pixelsAlreadyFilled;

    const player1PixelCount = (remainingPixels * 3n) / 4n;
    const player2PixelCount = remainingPixels - player1PixelCount;
    const player1Cost = pixelFee * player1PixelCount;
    const player2Cost = pixelFee * player2PixelCount;

    await currencyToken.connect(player1).mint(player1Cost);
    await currencyToken.connect(player1).approve(await pixelClash.getAddress(), player1Cost);

    await currencyToken.connect(player2).mint(player2Cost);
    await currencyToken.connect(player2).approve(await pixelClash.getAddress(), player2Cost);

    await fixture.purchasePixels(
      player1,
      arenaId,
      /*teamB=*/ false,
      player1PixelCount,
      /*referrer=*/ null,
    );
    await fixture.purchasePixels(
      player2,
      arenaId,
      /*teamB=*/ true,
      player2PixelCount,
      /*referrer=*/ null,
    );

    expect(await currencyToken.balanceOf(await player1.getAddress())).to.equal(0n);
    expect(await currencyToken.balanceOf(await player2.getAddress())).to.equal(0n);

    const arenaData = await pixelClash.getArenaData(arenaId);
    expect(arenaData.state).to.equal(ARENA_STATE_FULL);
    expect(arenaData.teamACount).to.equal(numPixelsPerTeamFromCreation + player1PixelCount);
    expect(arenaData.teamBCount).to.equal(numPixelsPerTeamFromCreation + player2PixelCount);
    expect(arenaData.teamACount + arenaData.teamBCount).to.equal(gridSize);
    expect(arenaData.revenue).to.equal(player1Cost + player2Cost);
    expect(arenaData.balance).to.equal(player1Cost + player2Cost);
  });

  it("player1 and player2 fill the arena in several transactions", async function () {
    const fixture = await Fixture.load();
    await fixture.createTestArena();

    const { player1, player2, currencyToken, pixelClash } = fixture;
    const arenaId = 1;
    const pixelFee = ONE_USDC;
    const numPixelsPerTeamFromCreation = INITIAL_PIXELS / 2n;
    const pixelsAlreadyFilled = numPixelsPerTeamFromCreation * 2n;
    const gridSize = BigInt(STANDARD_GRID_SIZE);
    const remainingPixels = gridSize - pixelsAlreadyFilled;

    const player1PixelCount = (remainingPixels * 3n) / 4n;
    const player2PixelCount = remainingPixels - player1PixelCount;
    const player1Cost = pixelFee * player1PixelCount;
    const player2Cost = pixelFee * player2PixelCount;

    await currencyToken.connect(player1).mint(player1Cost);
    await currencyToken.connect(player1).approve(await pixelClash.getAddress(), player1Cost);

    await currencyToken.connect(player2).mint(player2Cost);
    await currencyToken.connect(player2).approve(await pixelClash.getAddress(), player2Cost);

    await fixture.purchasePixels(
      player1,
      arenaId,
      /*teamB=*/ false,
      player1PixelCount / 2n,
      /*referrer=*/ null,
    );
    await fixture.purchasePixels(
      player2,
      arenaId,
      /*teamB=*/ true,
      player2PixelCount / 2n,
      /*referrer=*/ null,
    );
    await fixture.purchasePixels(
      player1,
      arenaId,
      /*teamB=*/ false,
      player1PixelCount - player1PixelCount / 2n,
      /*referrer=*/ null,
    );
    await fixture.purchasePixels(
      player2,
      arenaId,
      /*teamB=*/ true,
      player2PixelCount - player2PixelCount / 2n,
      /*referrer=*/ null,
    );

    expect(await currencyToken.balanceOf(await player1.getAddress())).to.equal(0n);
    expect(await currencyToken.balanceOf(await player2.getAddress())).to.equal(0n);

    const arenaData = await pixelClash.getArenaData(arenaId);
    expect(arenaData.state).to.equal(ARENA_STATE_FULL);
    expect(arenaData.teamACount).to.equal(numPixelsPerTeamFromCreation + player1PixelCount);
    expect(arenaData.teamBCount).to.equal(numPixelsPerTeamFromCreation + player2PixelCount);
    expect(arenaData.teamACount + arenaData.teamBCount).to.equal(gridSize);
    expect(arenaData.revenue).to.equal(player1Cost + player2Cost);
    expect(arenaData.balance).to.equal(player1Cost + player2Cost);
  });

  it("fill arena and draw", async function () {
    const fixture = await Fixture.load();
    await fixture.createTestArena();

    const { player1, player2, currencyToken, pixelClash } = fixture;
    const arenaId = 1;
    const pixelFee = ONE_USDC;
    const numPixelsPerTeamFromCreation = INITIAL_PIXELS / 2n;
    const pixelsAlreadyFilled = numPixelsPerTeamFromCreation * 2n;
    const gridSize = BigInt(STANDARD_GRID_SIZE);
    const remainingPixels = gridSize - pixelsAlreadyFilled;

    const player1PixelCount = (remainingPixels * 3n) / 4n;
    const player2PixelCount = remainingPixels - player1PixelCount;
    const player1Cost = pixelFee * player1PixelCount;
    const player2Cost = pixelFee * player2PixelCount;
    const totalRevenue = player1Cost + player2Cost;

    await currencyToken.connect(player1).mint(player1Cost);
    await currencyToken.connect(player1).approve(await pixelClash.getAddress(), player1Cost);
    await currencyToken.connect(player2).mint(player2Cost);
    await currencyToken.connect(player2).approve(await pixelClash.getAddress(), player2Cost);

    await fixture.purchasePixels(
      player1,
      arenaId,
      /*teamB=*/ false,
      player1PixelCount,
      /*referrer=*/ null,
    );
    await fixture.purchasePixels(
      player2,
      arenaId,
      /*teamB=*/ true,
      player2PixelCount,
      /*referrer=*/ null,
    );

    // Arena must be full before the draw
    expect((await pixelClash.getArenaData(arenaId)).state).to.equal(ARENA_STATE_FULL);

    // ── Trigger the draw ─────────────────────────────────────────────────────
    const drawPrice = ((await pixelClash.getDrawPrice()) * 110n) / 100n;
    const drawReceipt = await (
      await pixelClash.connect(player1).draw(arenaId, { value: drawPrice })
    ).wait();

    // Extract VRF request ID from the VRFRequest event
    const vrfRequestLog = drawReceipt!.logs
      .map((log) => {
        try {
          return pixelClash.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((log) => log?.name === "VRFRequest")!;
    const vrfRequestId = vrfRequestLog.args.vrfRequestId;

    // ── Check DRAWING state ───────────────────────────────────────────────────
    const arenaData = await pixelClash.getArenaData(arenaId);
    expect(arenaData.state).to.equal(ARENA_STATE_DRAWING);
    expect(arenaData.vrfRequestId).to.equal(vrfRequestId);
    expect(arenaData.teamACount).to.equal(numPixelsPerTeamFromCreation + player1PixelCount);
    expect(arenaData.teamBCount).to.equal(numPixelsPerTeamFromCreation + player2PixelCount);
    expect(arenaData.teamACount + arenaData.teamBCount).to.equal(gridSize);
    expect(arenaData.revenue).to.equal(totalRevenue);
    expect(arenaData.balance).to.equal(totalRevenue);

    // arenaIdsByVrfRequestId must map the request ID back to the arena
    expect(await pixelClash.arenaIdsByVrfRequestId(vrfRequestId)).to.equal(arenaId);
  });

  it("fill arena, draw, and swap", async function () {
    const fixture = await Fixture.load();
    await fixture.createTestArena();

    const {
      creator,
      player1,
      player2,
      currencyToken,
      pixelToken,
      pixelClash,
      mockVrfCoordinator,
      swapGateway,
    } = fixture;
    const arenaId = 1;
    const pixelFee = ONE_USDC;
    const numPixelsPerTeamFromCreation = INITIAL_PIXELS / 2n;
    const pixelsAlreadyFilled = numPixelsPerTeamFromCreation * 2n;
    const gridSize = BigInt(STANDARD_GRID_SIZE);
    const remainingPixels = gridSize - pixelsAlreadyFilled;

    const player1PixelCount = (remainingPixels * 3n) / 4n;
    const player2PixelCount = remainingPixels - player1PixelCount;
    const player1Cost = pixelFee * player1PixelCount;
    const player2Cost = pixelFee * player2PixelCount;
    const totalRevenue = player1Cost + player2Cost;

    await currencyToken.connect(player1).mint(player1Cost);
    await currencyToken.connect(player1).approve(await pixelClash.getAddress(), player1Cost);
    await currencyToken.connect(player2).mint(player2Cost);
    await currencyToken.connect(player2).approve(await pixelClash.getAddress(), player2Cost);

    await fixture.purchasePixels(
      player1,
      arenaId,
      /*teamB=*/ false,
      player1PixelCount,
      /*referrer=*/ null,
    );
    await fixture.purchasePixels(
      player2,
      arenaId,
      /*teamB=*/ true,
      player2PixelCount,
      /*referrer=*/ null,
    );

    // Arena must be full before the draw
    expect((await pixelClash.getArenaData(arenaId)).state).to.equal(ARENA_STATE_FULL);

    // ── Trigger the draw ─────────────────────────────────────────────────────
    // Send 110% of the estimated draw price to absorb gas-price fluctuations between
    // the view call and the actual transaction (the contract refunds any excess).
    const drawPrice = ((await pixelClash.getDrawPrice()) * 110n) / 100n;
    const drawReceipt = await (
      await pixelClash.connect(player1).draw(arenaId, { value: drawPrice })
    ).wait();

    // Extract VRF request ID from the VRFRequest event
    const vrfRequestLog = drawReceipt!.logs
      .map((log) => {
        try {
          return pixelClash.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((log) => log?.name === "VRFRequest")!;
    const vrfRequestId: bigint = vrfRequestLog.args.vrfRequestId;

    // Arena must be in DRAWING state, vrfRequestId must be set
    {
      const arenaData = await pixelClash.getArenaData(arenaId);
      expect(arenaData.state).to.equal(ARENA_STATE_DRAWING);
      expect(arenaData.vrfRequestId).to.equal(vrfRequestId);
    }
    expect(await pixelClash.arenaIdsByVrfRequestId(vrfRequestId)).to.equal(arenaId);

    // ── Mine 10 blocks (VRF_REQUEST_CONFIRMATIONS) ───────────────────────────
    await mine(10);

    // ── Snapshot balances before the draw triggers swap&burn ─────────────────
    const poolAddress = await swapGateway.swapPool();
    const pixelSupplyBefore = await pixelToken.totalSupply();
    const poolCurrencyBalanceBefore = await currencyToken.balanceOf(poolAddress);

    // ── Simulate the ChainLink VRF response ──────────────────────────────────
    // random = 0 → winner = pixel 0 (team A, owned by creator) → team A wins.
    const randomValue = 0n;

    // The coordinator's VRF consumer is the wrapper, not VRFConsumer directly.
    const vrfConsumerContract = await ethers.getContractAt(
      "VRFConsumer",
      await pixelClash.vrfConsumer(),
    );
    const vrfWrapperAddress = await vrfConsumerContract.i_vrfV2PlusWrapper();

    await expect(
      mockVrfCoordinator.fulfillRandomWordsWithOverride(vrfRequestId, vrfWrapperAddress, [
        randomValue,
      ]),
    )
      .to.emit(pixelClash, "ArenaClosure")
      .withArgs(arenaId, vrfRequestId, 0n /* winning pixel index */);

    // ── Check arena state after draw ─────────────────────────────────────────
    const arenaData = await pixelClash.getArenaData(arenaId);
    expect(arenaData.state).to.equal(ARENA_STATE_DRAWN);
    expect(arenaData.winner).to.equal(0n); // pixel 0
    expect(arenaData.vrfRequestId).to.equal(0n); // cleared after draw
    expect(arenaData.revenue).to.equal(totalRevenue);
    expect(arenaData.teamACount + arenaData.teamBCount).to.equal(gridSize);

    // arenaIdsByVrfRequestId must be cleared
    expect(await pixelClash.arenaIdsByVrfRequestId(vrfRequestId)).to.equal(0n);

    // ── Check prizes ─────────────────────────────────────────────────────────
    // No referrers, so sponsorPrize and topReferralPrize are both zero.
    const expectedWinnerPrize = (totalRevenue * 45n) / 100n;
    const expectedTeamPrize = (totalRevenue * 25n) / 100n;
    const expectedSponsorPrize = 0n;
    const expectedTopReferralPrize = 0n;
    const expectedArenaOwnerPrize = (totalRevenue * 5n) / 100n;
    const expectedTotalPrizes =
      expectedWinnerPrize +
      expectedTeamPrize +
      expectedSponsorPrize +
      expectedTopReferralPrize +
      expectedArenaOwnerPrize;
    const expectedArenaProtocolFee = totalRevenue - expectedTotalPrizes;

    // arena.balance = total prizes (protocol fee was removed during draw)
    expect(arenaData.balance).to.equal(expectedTotalPrizes);

    const allPrizes = await pixelClash.getAllPrizes(arenaId);
    expect(allPrizes.winnerPrize).to.equal(expectedWinnerPrize);
    expect(allPrizes.teamPrize).to.equal(expectedTeamPrize);
    expect(allPrizes.sponsorPrize).to.equal(expectedSponsorPrize);
    expect(allPrizes.topReferralPrize).to.equal(expectedTopReferralPrize);
    expect(allPrizes.arenaOwnerPrize).to.equal(expectedArenaOwnerPrize);

    // ── Per-player prizes ─────────────────────────────────────────────────────
    // Team A won: teamACount = numPixelsPerTeamFromCreation (creator) + player1PixelCount
    const teamACount = numPixelsPerTeamFromCreation + player1PixelCount;

    const creatorAddress = await creator.getAddress();
    const player1Address = await player1.getAddress();
    const player2Address = await player2.getAddress();

    // creator: winner (pixel 0) + team A proportional + arena owner
    const creatorExpectedTeamPrize =
      (totalRevenue * 25n * numPixelsPerTeamFromCreation) / (100n * teamACount);
    const creatorPrizes = await pixelClash.getPrizesFor(arenaId, creatorAddress);
    expect(creatorPrizes.winnerPrize).to.equal(expectedWinnerPrize);
    expect(creatorPrizes.teamPrize).to.equal(creatorExpectedTeamPrize);
    expect(creatorPrizes.sponsorPrize).to.equal(0n);
    expect(creatorPrizes.topReferralPrize).to.equal(0n);
    expect(creatorPrizes.arenaOwnerPrize).to.equal(expectedArenaOwnerPrize);

    const creatorTotalPrize = await pixelClash.getPrizeFor(arenaId, creatorAddress);
    expect(creatorTotalPrize).to.equal(
      expectedWinnerPrize + creatorExpectedTeamPrize + expectedArenaOwnerPrize,
    );

    // player1: team A proportional only
    const player1ExpectedTeamPrize = (totalRevenue * 25n * player1PixelCount) / (100n * teamACount);
    const player1Prizes = await pixelClash.getPrizesFor(arenaId, player1Address);
    expect(player1Prizes.winnerPrize).to.equal(0n);
    expect(player1Prizes.teamPrize).to.equal(player1ExpectedTeamPrize);
    expect(player1Prizes.sponsorPrize).to.equal(0n);
    expect(player1Prizes.topReferralPrize).to.equal(0n);
    expect(player1Prizes.arenaOwnerPrize).to.equal(0n);

    const player1TotalPrize = await pixelClash.getPrizeFor(arenaId, player1Address);
    expect(player1TotalPrize).to.equal(player1ExpectedTeamPrize);

    // player2: team B lost, no prizes
    const player2Prizes = await pixelClash.getPrizesFor(arenaId, player2Address);
    expect(player2Prizes.winnerPrize).to.equal(0n);
    expect(player2Prizes.teamPrize).to.equal(0n);
    expect(player2Prizes.sponsorPrize).to.equal(0n);
    expect(player2Prizes.topReferralPrize).to.equal(0n);
    expect(player2Prizes.arenaOwnerPrize).to.equal(0n);

    const player2TotalPrize = await pixelClash.getPrizeFor(arenaId, player2Address);
    expect(player2TotalPrize).to.equal(0n);

    // team prizes must add up to expectedTeamPrize (modulo integer division rounding)
    expect(creatorExpectedTeamPrize + player1ExpectedTeamPrize).to.be.lte(expectedTeamPrize);

    // ── Swap & burn ───────────────────────────────────────────────────────────
    const swappedAmount = ARENA_CREATION_FEE + expectedArenaProtocolFee;

    // protocolRevenue is zeroed on a successful swap — nothing stranded in PixelClash.
    expect(await pixelClash.protocolRevenue()).to.equal(0n);

    // Only prize money remains in PixelClash; the protocol cut was transferred to the pool.
    expect(await currencyToken.balanceOf(await pixelClash.getAddress())).to.equal(
      expectedTotalPrizes,
    );

    // The full protocol cut landed in the Uniswap pool.
    expect(await currencyToken.balanceOf(poolAddress)).to.equal(
      poolCurrencyBalanceBefore + swappedAmount,
    );

    // The pixel tokens received from the swap were burned.
    // At tick 0 (1:1 wei price, 0.05 % pool fee, 1 % max slippage), the burned amount is bounded
    // between swappedAmount × 0.9895 and swappedAmount.
    const burnedPixels = pixelSupplyBefore - (await pixelToken.totalSupply());
    expect(burnedPixels).to.be.gte((swappedAmount * 9895n) / 10000n);
    expect(burnedPixels).to.be.lte(swappedAmount);
  });

  it("time out, draw, and swap", async function () {
    const fixture = await Fixture.load();
    await fixture.createTestArena();

    const {
      creator,
      player1,
      player2,
      currencyToken,
      pixelToken,
      pixelClash,
      mockVrfCoordinator,
      swapGateway,
    } = fixture;
    const arenaId = 1;
    const pixelFee = ONE_USDC;
    const numPixelsPerTeamFromCreation = INITIAL_PIXELS / 2n;

    // Partially fill the arena — leave it well short of the grid so it stays OPEN
    const player1PixelCount = 100n; // team A
    const player2PixelCount = 80n; // team B
    const player1Cost = pixelFee * player1PixelCount;
    const player2Cost = pixelFee * player2PixelCount;
    const totalRevenue = player1Cost + player2Cost;

    await currencyToken.connect(player1).mint(player1Cost);
    await currencyToken.connect(player1).approve(await pixelClash.getAddress(), player1Cost);
    await currencyToken.connect(player2).mint(player2Cost);
    await currencyToken.connect(player2).approve(await pixelClash.getAddress(), player2Cost);

    await fixture.purchasePixels(
      player1,
      arenaId,
      /*teamB=*/ false,
      player1PixelCount,
      /*referrer=*/ null,
    );
    await fixture.purchasePixels(
      player2,
      arenaId,
      /*teamB=*/ true,
      player2PixelCount,
      /*referrer=*/ null,
    );

    // Arena is still OPEN (not full)
    expect((await pixelClash.getArenaData(arenaId)).state).to.equal(ARENA_STATE_OPEN);

    // ── Advance time past maxDuration ────────────────────────────────────────
    await time.increase(STANDARD_MAX_DURATION + 1n);

    // Arena must now be in TIMED_OUT state
    expect((await pixelClash.getArenaData(arenaId)).state).to.equal(ARENA_STATE_TIMED_OUT);

    // ── Trigger the draw ─────────────────────────────────────────────────────
    const drawPrice = ((await pixelClash.getDrawPrice()) * 110n) / 100n;
    const drawReceipt = await (
      await pixelClash.connect(player1).draw(arenaId, { value: drawPrice })
    ).wait();

    // Extract VRF request ID from the VRFRequest event
    const vrfRequestLog = drawReceipt!.logs
      .map((log) => {
        try {
          return pixelClash.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((log) => log?.name === "VRFRequest")!;
    const vrfRequestId: bigint = vrfRequestLog.args.vrfRequestId;

    // Arena must be in DRAWING state, vrfRequestId must be set
    {
      const arenaData = await pixelClash.getArenaData(arenaId);
      expect(arenaData.state).to.equal(ARENA_STATE_DRAWING);
      expect(arenaData.vrfRequestId).to.equal(vrfRequestId);
    }
    expect(await pixelClash.arenaIdsByVrfRequestId(vrfRequestId)).to.equal(arenaId);

    // ── Mine 10 blocks (VRF_REQUEST_CONFIRMATIONS) ───────────────────────────
    await mine(10);

    // ── Snapshot balances before the draw triggers swap&burn ─────────────────
    const poolAddress = await swapGateway.swapPool();
    const pixelSupplyBefore = await pixelToken.totalSupply();
    const poolCurrencyBalanceBefore = await currencyToken.balanceOf(poolAddress);

    // ── Simulate the ChainLink VRF response ──────────────────────────────────
    // random = 0 → winner = 0 % acquiredPixels = 0 → pixel 0 (team A, owned by creator) → team A wins.
    const randomValue = 0n;

    const vrfConsumerContract = await ethers.getContractAt(
      "VRFConsumer",
      await pixelClash.vrfConsumer(),
    );
    const vrfWrapperAddress = await vrfConsumerContract.i_vrfV2PlusWrapper();

    await expect(
      mockVrfCoordinator.fulfillRandomWordsWithOverride(vrfRequestId, vrfWrapperAddress, [
        randomValue,
      ]),
    )
      .to.emit(pixelClash, "ArenaClosure")
      .withArgs(arenaId, vrfRequestId, 0n /* winning pixel index */);

    // ── Check arena state after draw ─────────────────────────────────────────
    const arenaData = await pixelClash.getArenaData(arenaId);
    expect(arenaData.state).to.equal(ARENA_STATE_DRAWN);
    expect(arenaData.winner).to.equal(0n); // pixel 0
    expect(arenaData.vrfRequestId).to.equal(0n); // cleared after draw
    expect(arenaData.revenue).to.equal(totalRevenue);
    // Grid is not fully filled — the arena timed out with pixels still available
    expect(arenaData.teamACount + arenaData.teamBCount).to.be.lt(BigInt(STANDARD_GRID_SIZE));

    // arenaIdsByVrfRequestId must be cleared
    expect(await pixelClash.arenaIdsByVrfRequestId(vrfRequestId)).to.equal(0n);

    // ── Check prizes ─────────────────────────────────────────────────────────
    // No referrers, so sponsorPrize and topReferralPrize are both zero.
    const expectedWinnerPrize = (totalRevenue * 45n) / 100n;
    const expectedTeamPrize = (totalRevenue * 25n) / 100n;
    const expectedSponsorPrize = 0n;
    const expectedTopReferralPrize = 0n;
    const expectedArenaOwnerPrize = (totalRevenue * 5n) / 100n;
    const expectedTotalPrizes =
      expectedWinnerPrize +
      expectedTeamPrize +
      expectedSponsorPrize +
      expectedTopReferralPrize +
      expectedArenaOwnerPrize;
    const expectedArenaProtocolFee = totalRevenue - expectedTotalPrizes;

    // arena.balance = total prizes (protocol fee was removed during draw)
    expect(arenaData.balance).to.equal(expectedTotalPrizes);

    const allPrizes = await pixelClash.getAllPrizes(arenaId);
    expect(allPrizes.winnerPrize).to.equal(expectedWinnerPrize);
    expect(allPrizes.teamPrize).to.equal(expectedTeamPrize);
    expect(allPrizes.sponsorPrize).to.equal(expectedSponsorPrize);
    expect(allPrizes.topReferralPrize).to.equal(expectedTopReferralPrize);
    expect(allPrizes.arenaOwnerPrize).to.equal(expectedArenaOwnerPrize);

    // ── Per-player prizes ─────────────────────────────────────────────────────
    // Team A won: teamACount = numPixelsPerTeamFromCreation (creator) + player1PixelCount
    const teamACount = numPixelsPerTeamFromCreation + player1PixelCount;

    const creatorAddress = await creator.getAddress();
    const player1Address = await player1.getAddress();
    const player2Address = await player2.getAddress();

    // creator: winner (pixel 0) + team A proportional + arena owner
    const creatorExpectedTeamPrize =
      (totalRevenue * 25n * numPixelsPerTeamFromCreation) / (100n * teamACount);
    const creatorPrizes = await pixelClash.getPrizesFor(arenaId, creatorAddress);
    expect(creatorPrizes.winnerPrize).to.equal(expectedWinnerPrize);
    expect(creatorPrizes.teamPrize).to.equal(creatorExpectedTeamPrize);
    expect(creatorPrizes.sponsorPrize).to.equal(0n);
    expect(creatorPrizes.topReferralPrize).to.equal(0n);
    expect(creatorPrizes.arenaOwnerPrize).to.equal(expectedArenaOwnerPrize);

    const creatorTotalPrize = await pixelClash.getPrizeFor(arenaId, creatorAddress);
    expect(creatorTotalPrize).to.equal(
      expectedWinnerPrize + creatorExpectedTeamPrize + expectedArenaOwnerPrize,
    );

    // player1: team A proportional only
    const player1ExpectedTeamPrize = (totalRevenue * 25n * player1PixelCount) / (100n * teamACount);
    const player1Prizes = await pixelClash.getPrizesFor(arenaId, player1Address);
    expect(player1Prizes.winnerPrize).to.equal(0n);
    expect(player1Prizes.teamPrize).to.equal(player1ExpectedTeamPrize);
    expect(player1Prizes.sponsorPrize).to.equal(0n);
    expect(player1Prizes.topReferralPrize).to.equal(0n);
    expect(player1Prizes.arenaOwnerPrize).to.equal(0n);

    const player1TotalPrize = await pixelClash.getPrizeFor(arenaId, player1Address);
    expect(player1TotalPrize).to.equal(player1ExpectedTeamPrize);

    // player2: team B lost, no prizes
    const player2Prizes = await pixelClash.getPrizesFor(arenaId, player2Address);
    expect(player2Prizes.winnerPrize).to.equal(0n);
    expect(player2Prizes.teamPrize).to.equal(0n);
    expect(player2Prizes.sponsorPrize).to.equal(0n);
    expect(player2Prizes.topReferralPrize).to.equal(0n);
    expect(player2Prizes.arenaOwnerPrize).to.equal(0n);

    const player2TotalPrize = await pixelClash.getPrizeFor(arenaId, player2Address);
    expect(player2TotalPrize).to.equal(0n);

    // team prizes must add up to expectedTeamPrize (modulo integer division rounding)
    expect(creatorExpectedTeamPrize + player1ExpectedTeamPrize).to.be.lte(expectedTeamPrize);

    // ── Swap & burn ───────────────────────────────────────────────────────────
    const swappedAmount = ARENA_CREATION_FEE + expectedArenaProtocolFee;

    // protocolRevenue is zeroed on a successful swap — nothing stranded in PixelClash.
    expect(await pixelClash.protocolRevenue()).to.equal(0n);

    // Only prize money remains in PixelClash; the protocol cut was transferred to the pool.
    expect(await currencyToken.balanceOf(await pixelClash.getAddress())).to.equal(
      expectedTotalPrizes,
    );

    // The full protocol cut landed in the Uniswap pool.
    expect(await currencyToken.balanceOf(poolAddress)).to.equal(
      poolCurrencyBalanceBefore + swappedAmount,
    );

    // The pixel tokens received from the swap were burned.
    // At tick 0 (1:1 wei price, 0.05 % pool fee, 1 % max slippage), the burned amount is bounded
    // between swappedAmount × 0.9895 and swappedAmount.
    const burnedPixels = pixelSupplyBefore - (await pixelToken.totalSupply());
    expect(burnedPixels).to.be.gte((swappedAmount * 9895n) / 10000n);
    expect(burnedPixels).to.be.lte(swappedAmount);
  });

  it("self-referral is rejected", async function () {
    const fixture = await Fixture.load();
    await fixture.createTestArena();

    const { player1, currencyToken, pixelClash } = fixture;
    const player1Address = await player1.getAddress();

    await currencyToken.connect(player1).mint(DISCOUNTED_PIXEL_FEE);
    await currencyToken
      .connect(player1)
      .approve(await pixelClash.getAddress(), DISCOUNTED_PIXEL_FEE);

    await expect(
      pixelClash
        .connect(player1)
        .purchasePixelsWithPermit(
          1,
          false,
          1,
          player1Address,
          ethers.MaxUint256,
          0,
          ethers.ZeroHash,
          ethers.ZeroHash,
        ),
    ).to.be.revertedWithCustomError(pixelClash, "SelfReferralForbidden");
  });

  it("player pays 10% less when a referrer is provided", async function () {
    const fixture = await Fixture.load();
    await fixture.createTestArena();

    const { creator, player1, currencyToken, pixelClash } = fixture;
    const arenaId = 1;
    const count = 10n;
    const expectedFee = DISCOUNTED_PIXEL_FEE * count; // 9 USDC for 10 pixels

    await currencyToken.connect(player1).mint(expectedFee);
    await currencyToken.connect(player1).approve(await pixelClash.getAddress(), expectedFee);

    await fixture.purchasePixels(player1, arenaId, false, count, creator);

    // Player spent exactly the discounted amount — no tokens left over.
    expect(await currencyToken.balanceOf(await player1.getAddress())).to.equal(0n);

    // Arena revenue equals the discounted amount actually received, not the nominal full price.
    const arenaData = await pixelClash.getArenaData(arenaId);
    expect(arenaData.revenue).to.equal(expectedFee);
    expect(arenaData.balance).to.equal(expectedFee);
  });

  it("non-referred purchase continues to pay the full price", async function () {
    const fixture = await Fixture.load();
    await fixture.createTestArena();

    const { player1, currencyToken, pixelClash } = fixture;
    const arenaId = 1;
    const count = 10n;
    const fullFee = ONE_USDC * count;

    await currencyToken.connect(player1).mint(fullFee);
    await currencyToken.connect(player1).approve(await pixelClash.getAddress(), fullFee);

    await fixture.purchasePixels(player1, arenaId, false, count, null);

    expect(await currencyToken.balanceOf(await player1.getAddress())).to.equal(0n);
    const arenaData = await pixelClash.getArenaData(arenaId);
    expect(arenaData.revenue).to.equal(fullFee);
    expect(arenaData.balance).to.equal(fullFee);
  });

  it("referral revenue is tracked at the discounted amount paid", async function () {
    const fixture = await Fixture.load();
    await fixture.createTestArena();

    const { creator, player1, currencyToken, pixelClash } = fixture;
    const arenaId = 1;
    const count = 10n;
    const discountedFee = DISCOUNTED_PIXEL_FEE * count;
    const creatorAddress = await creator.getAddress();

    await currencyToken.connect(player1).mint(discountedFee);
    await currencyToken.connect(player1).approve(await pixelClash.getAddress(), discountedFee);

    await fixture.purchasePixels(player1, arenaId, false, count, creator);

    expect(await pixelClash.getReferralRevenueFrom(arenaId, creatorAddress)).to.equal(
      discountedFee,
    );

    const topReferrers = await pixelClash.getTopReferrers(arenaId);
    expect(topReferrers.length).to.equal(1);
    expect(topReferrers[0].referrer).to.equal(creatorAddress);
    expect(topReferrers[0].revenue).to.equal(discountedFee);
  });

  it("multiple referred purchases by different players accumulate on the same referrer", async function () {
    const fixture = await Fixture.load();
    await fixture.createTestArena();

    const { creator, player1, player2, currencyToken, pixelClash } = fixture;
    const arenaId = 1;
    const count1 = 10n;
    const count2 = 20n;
    const fee1 = DISCOUNTED_PIXEL_FEE * count1;
    const fee2 = DISCOUNTED_PIXEL_FEE * count2;
    const creatorAddress = await creator.getAddress();

    await currencyToken.connect(player1).mint(fee1);
    await currencyToken.connect(player1).approve(await pixelClash.getAddress(), fee1);
    await fixture.purchasePixels(player1, arenaId, false, count1, creator);

    await currencyToken.connect(player2).mint(fee2);
    await currencyToken.connect(player2).approve(await pixelClash.getAddress(), fee2);
    await fixture.purchasePixels(player2, arenaId, true, count2, creator);

    expect(await pixelClash.getReferralRevenueFrom(arenaId, creatorAddress)).to.equal(fee1 + fee2);

    // Arena revenue is the sum of both discounted purchases.
    const arenaData = await pixelClash.getArenaData(arenaId);
    expect(arenaData.revenue).to.equal(fee1 + fee2);
  });

  it("getTopReferrers returns referrers sorted by revenue descending", async function () {
    const fixture = await Fixture.load();
    await fixture.createTestArena();

    const { creator, player1, player2, currencyToken, pixelClash } = fixture;
    const arenaId = 1;
    const creatorAddress = await creator.getAddress();
    const player1Address = await player1.getAddress();

    // player1 buys 20 pixels referred by creator — the higher-revenue referrer.
    const count1 = 20n;
    const fee1 = DISCOUNTED_PIXEL_FEE * count1;
    await currencyToken.connect(player1).mint(fee1);
    await currencyToken.connect(player1).approve(await pixelClash.getAddress(), fee1);
    await fixture.purchasePixels(player1, arenaId, false, count1, creator);

    // player2 buys 5 pixels referred by player1 — the lower-revenue referrer.
    const count2 = 5n;
    const fee2 = DISCOUNTED_PIXEL_FEE * count2;
    await currencyToken.connect(player2).mint(fee2);
    await currencyToken.connect(player2).approve(await pixelClash.getAddress(), fee2);
    await fixture.purchasePixels(player2, arenaId, true, count2, player1);

    const topReferrers = await pixelClash.getTopReferrers(arenaId);
    expect(topReferrers.length).to.equal(2);
    // Rank 1: creator referred 20 pixels → more revenue.
    expect(topReferrers[0].referrer).to.equal(creatorAddress);
    expect(topReferrers[0].revenue).to.equal(fee1);
    // Rank 2: player1 referred 5 pixels → less revenue.
    expect(topReferrers[1].referrer).to.equal(player1Address);
    expect(topReferrers[1].revenue).to.equal(fee2);
  });

  it("partial fill refund is calculated at the discounted per-pixel rate", async function () {
    const fixture = await Fixture.load();
    const { creator, player1, player2, currencyToken, pixelClash } = fixture;

    await currencyToken.connect(creator).mint(ARENA_CREATION_FEE);
    await currencyToken.connect(creator).approve(await pixelClash.getAddress(), ARENA_CREATION_FEE);
    await pixelClash.connect(creator).createArenaWithPermit(
      {
        teamAName: "Dogs",
        teamALogo: "\u{1F436}",
        teamALogoCid: ethers.ZeroHash,
        teamAColor: 0xff0000,
        teamBName: "Cats",
        teamBLogo: "\u{1F431}",
        teamBLogoCid: ethers.ZeroHash,
        teamBColor: 0x0000ff,
        gridSize: STANDARD_GRID_SIZE,
        pixelFee: ONE_USDC,
        maxDuration: STANDARD_MAX_DURATION,
      },
      [],
      ethers.MaxUint256,
      0,
      ethers.ZeroHash,
      ethers.ZeroHash,
    );
    const arenaId = 1;

    // Initial pixels: 5 teamA + 5 teamB = 10 used, 9990 available.
    // player1 fills 9988 pixels without a referral (teamA), leaving 2 available.
    const fillCount = BigInt(STANDARD_GRID_SIZE) - INITIAL_PIXELS - 2n;
    const fillCost = ONE_USDC * fillCount;
    await currencyToken.connect(player1).mint(fillCost);
    await currencyToken.connect(player1).approve(await pixelClash.getAddress(), fillCost);
    await fixture.purchasePixels(player1, arenaId, false, fillCount, null);

    // player2 requests 10 pixels with a referrer — only 2 can actually be acquired.
    const requestCount = 10n;
    const approvedFee = DISCOUNTED_PIXEL_FEE * requestCount;
    await currencyToken.connect(player2).mint(approvedFee);
    await currencyToken.connect(player2).approve(await pixelClash.getAddress(), approvedFee);

    const player2Address = await player2.getAddress();
    const balanceBefore = await currencyToken.balanceOf(player2Address);
    await fixture.purchasePixels(player2, arenaId, false, requestCount, creator);
    const balanceAfter = await currencyToken.balanceOf(player2Address);

    // Net deducted from player2 = 2 × DISCOUNTED_PIXEL_FEE (refund for 8 unacquired pixels).
    const acquiredCount = 2n;
    const netPayment = DISCOUNTED_PIXEL_FEE * acquiredCount;
    expect(balanceBefore - balanceAfter).to.equal(netPayment);

    // Arena should now be FULL.
    const arenaData = await pixelClash.getArenaData(arenaId);
    expect(arenaData.state).to.equal(ARENA_STATE_FULL);

    // Total revenue = full-price fill + discounted partial fill.
    expect(arenaData.revenue).to.equal(fillCost + netPayment);

    // Referral revenue tracks only the 2 pixels that were actually acquired.
    const creatorAddress = await creator.getAddress();
    expect(await pixelClash.getReferralRevenueFrom(arenaId, creatorAddress)).to.equal(netPayment);
  });

  it("referred and non-referred purchases in the same arena are independent", async function () {
    const fixture = await Fixture.load();
    await fixture.createTestArena();

    const { creator, player1, player2, currencyToken, pixelClash } = fixture;
    const arenaId = 1;
    const creatorAddress = await creator.getAddress();

    // player1 buys 5 pixels without a referral → full price.
    const nonReferralCount = 5n;
    const nonReferralFee = ONE_USDC * nonReferralCount;
    await currencyToken.connect(player1).mint(nonReferralFee);
    await currencyToken.connect(player1).approve(await pixelClash.getAddress(), nonReferralFee);
    await fixture.purchasePixels(player1, arenaId, false, nonReferralCount, null);

    // player2 buys 5 pixels referred by creator → 10% off.
    const referralCount = 5n;
    const referralFee = DISCOUNTED_PIXEL_FEE * referralCount;
    await currencyToken.connect(player2).mint(referralFee);
    await currencyToken.connect(player2).approve(await pixelClash.getAddress(), referralFee);
    await fixture.purchasePixels(player2, arenaId, true, referralCount, creator);

    // Combined revenue = full price + discounted price.
    const arenaData = await pixelClash.getArenaData(arenaId);
    expect(arenaData.revenue).to.equal(nonReferralFee + referralFee);
    expect(arenaData.balance).to.equal(nonReferralFee + referralFee);

    // Referral revenue tracks only the referred purchase amount.
    expect(await pixelClash.getReferralRevenueFrom(arenaId, creatorAddress)).to.equal(referralFee);

    // No referral revenue was recorded for the address that made the non-referred purchase.
    expect(await pixelClash.getReferralRevenueFrom(arenaId, await player1.getAddress())).to.equal(
      0n,
    );
  });

  it("sponsor prize equals 5% of revenue when the winning pixel was referred", async function () {
    const fixture = await Fixture.load();
    await fixture.createTestArena();

    const { creator, player1, currencyToken, pixelClash, mockVrfCoordinator } = fixture;
    const arenaId = 1;

    // player1 buys 100 team-A pixels with creator as referrer
    const pixelCount = 100n;
    const pixelCost = DISCOUNTED_PIXEL_FEE * pixelCount;
    await currencyToken.connect(player1).mint(pixelCost);
    await currencyToken.connect(player1).approve(await pixelClash.getAddress(), pixelCost);
    await fixture.purchasePixels(player1, arenaId, false, pixelCount, creator);

    await time.increase(STANDARD_MAX_DURATION + 1n);
    expect((await pixelClash.getArenaData(arenaId)).state).to.equal(ARENA_STATE_TIMED_OUT);

    const drawPrice = ((await pixelClash.getDrawPrice()) * 110n) / 100n;
    const drawReceipt = await (
      await pixelClash.connect(player1).draw(arenaId, { value: drawPrice })
    ).wait();

    const vrfRequestId: bigint = drawReceipt!.logs
      .map((log) => {
        try {
          return pixelClash.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((log) => log?.name === "VRFRequest")!.args.vrfRequestId;

    await mine(10);

    const vrfConsumerContract = await ethers.getContractAt(
      "VRFConsumer",
      await pixelClash.vrfConsumer(),
    );
    const vrfWrapperAddress = await vrfConsumerContract.i_vrfV2PlusWrapper();

    // teamACount = 5 (creator, no referrer) + 100 (player1, referrer=creator) = 105
    // teamBCount = 5 (creator, no referrer); acquiredPixels = 110
    // random=5 → winner = 5 % 110 = 5 → teamA pixel 5 → player1's range, referrer=creator
    await expect(
      mockVrfCoordinator.fulfillRandomWordsWithOverride(vrfRequestId, vrfWrapperAddress, [5n]),
    )
      .to.emit(pixelClash, "ArenaClosure")
      .withArgs(arenaId, vrfRequestId, 5n);

    const arenaData = await pixelClash.getArenaData(arenaId);
    expect(arenaData.state).to.equal(ARENA_STATE_DRAWN);
    expect(arenaData.winner).to.equal(5n);

    const totalRevenue = pixelCost;
    const expectedSponsorPrize = (totalRevenue * 5n) / 100n;

    const allPrizes = await pixelClash.getAllPrizes(arenaId);
    expect(allPrizes.sponsorPrize).to.equal(expectedSponsorPrize);

    const creatorAddress = await creator.getAddress();
    const player1Address = await player1.getAddress();

    // creator referred the winning pixel → gets the sponsor prize
    const creatorPrizes = await pixelClash.getPrizesFor(arenaId, creatorAddress);
    expect(creatorPrizes.sponsorPrize).to.equal(expectedSponsorPrize);

    // player1 owns the winning pixel but is not its referrer → no sponsor prize
    const player1Prizes = await pixelClash.getPrizesFor(arenaId, player1Address);
    expect(player1Prizes.sponsorPrize).to.equal(0n);
  });

  it("top 3 referral prizes are 9%, 4%, and 2% of revenue", async function () {
    const fixture = await Fixture.load();
    await fixture.createTestArena();

    const { owner, player1, player2, currencyToken, pixelClash, mockVrfCoordinator } = fixture;
    const arenaId = 1;
    const allSigners = await ethers.getSigners();
    const referrer1 = allSigners[4]; // will rank #1 by referral revenue
    const referrer2 = allSigners[5]; // will rank #2
    const referrer3 = allSigners[6]; // will rank #3

    // player1 buys 300 team-A pixels with referrer1 → highest referral revenue
    const count1 = 300n;
    const cost1 = DISCOUNTED_PIXEL_FEE * count1;
    await currencyToken.connect(player1).mint(cost1);
    await currencyToken.connect(player1).approve(await pixelClash.getAddress(), cost1);
    await fixture.purchasePixels(player1, arenaId, false, count1, referrer1);

    // player2 buys 200 team-B pixels with referrer2 → second highest
    const count2 = 200n;
    const cost2 = DISCOUNTED_PIXEL_FEE * count2;
    await currencyToken.connect(player2).mint(cost2);
    await currencyToken.connect(player2).approve(await pixelClash.getAddress(), cost2);
    await fixture.purchasePixels(player2, arenaId, true, count2, referrer2);

    // owner buys 100 team-A pixels with referrer3 → third highest
    const count3 = 100n;
    const cost3 = DISCOUNTED_PIXEL_FEE * count3;
    await currencyToken.connect(owner).mint(cost3);
    await currencyToken.connect(owner).approve(await pixelClash.getAddress(), cost3);
    await fixture.purchasePixels(owner, arenaId, false, count3, referrer3);

    await time.increase(STANDARD_MAX_DURATION + 1n);

    const drawPrice = ((await pixelClash.getDrawPrice()) * 110n) / 100n;
    const drawReceipt = await (
      await pixelClash.connect(player1).draw(arenaId, { value: drawPrice })
    ).wait();

    const vrfRequestId: bigint = drawReceipt!.logs
      .map((log) => {
        try {
          return pixelClash.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((log) => log?.name === "VRFRequest")!.args.vrfRequestId;

    await mine(10);

    const vrfConsumerContract = await ethers.getContractAt(
      "VRFConsumer",
      await pixelClash.vrfConsumer(),
    );
    const vrfWrapperAddress = await vrfConsumerContract.i_vrfV2PlusWrapper();

    // teamACount = 5 (creator) + 300 (player1) + 100 (owner) = 405
    // teamBCount = 5 (creator) + 200 (player2) = 205; acquiredPixels = 610
    // random=0 → winner = 0 % 610 = 0 → teamA pixel 0 → creator's range, no referrer
    await expect(
      mockVrfCoordinator.fulfillRandomWordsWithOverride(vrfRequestId, vrfWrapperAddress, [0n]),
    )
      .to.emit(pixelClash, "ArenaClosure")
      .withArgs(arenaId, vrfRequestId, 0n);

    expect((await pixelClash.getArenaData(arenaId)).state).to.equal(ARENA_STATE_DRAWN);

    const totalRevenue = cost1 + cost2 + cost3;
    const expectedPrize1 = (totalRevenue * 9n) / 100n;
    const expectedPrize2 = (totalRevenue * 4n) / 100n;
    const expectedPrize3 = (totalRevenue * 2n) / 100n;

    const allPrizes = await pixelClash.getAllPrizes(arenaId);
    expect(allPrizes.topReferralPrize).to.equal(expectedPrize1 + expectedPrize2 + expectedPrize3);

    const referrer1Prizes = await pixelClash.getPrizesFor(arenaId, await referrer1.getAddress());
    expect(referrer1Prizes.topReferralPrize).to.equal(expectedPrize1);

    const referrer2Prizes = await pixelClash.getPrizesFor(arenaId, await referrer2.getAddress());
    expect(referrer2Prizes.topReferralPrize).to.equal(expectedPrize2);

    const referrer3Prizes = await pixelClash.getPrizesFor(arenaId, await referrer3.getAddress());
    expect(referrer3Prizes.topReferralPrize).to.equal(expectedPrize3);
  });

  describe("tags", function () {
    it("indexes arena tags and the global catalog with arena counts", async function () {
      const fixture = await Fixture.load();
      const { creator, pixelClash } = fixture;
      await fixture.fund(creator, ARENA_CREATION_FEE);
      expect(
        await pixelClash
          .connect(creator)
          .createArenaWithPermit.staticCall(
            arenaParams(),
            ["sport"],
            ethers.MaxUint256,
            0,
            ethers.ZeroHash,
            ethers.ZeroHash,
          ),
      ).to.equal(1n);
      await fixture.createArena(["sport", "calcio-⚽"]);
      await fixture.createArena(["sport", "crypto"]);

      expect(await pixelClash.getArenaTags(1)).to.deep.equal(["sport", "calcio-⚽"]);
      expect(await pixelClash.getArenaTags(2)).to.deep.equal(["sport", "crypto"]);
      const [tags, counts, total] = await pixelClash.getTags(0, 10);
      expect(tags).to.deep.equal(["sport", "calcio-⚽", "crypto"]);
      expect(counts).to.deep.equal([2n, 1n, 1n]);
      expect(total).to.equal(3n);
      const [page] = await pixelClash.getTags(1, 1);
      expect(page).to.deep.equal(["calcio-⚽"]);
      expect(await pixelClash.getArenaCountByTag("sport")).to.equal(2n);
      expect(await pixelClash.getArenasByTag("sport", 0, 10)).to.deep.equal([2n, 1n]);
    });

    it("rejects non-canonical, duplicate and excess tags", async function () {
      const fixture = await Fixture.load();
      const tagMethods = await ethers.getContractAt("TagMethods", ethers.ZeroAddress);
      for (const tag of ["Sport", "two words", "", "x".repeat(33), "tab\t"]) {
        await expect(fixture.createArena([tag])).to.be.revertedWithCustomError(
          tagMethods,
          "InvalidTag",
        );
      }
      await expect(fixture.createArena(["sport", "sport"])).to.be.revertedWithCustomError(
        tagMethods,
        "InvalidTag",
      );
      await expect(fixture.createArena(["a", "b", "c", "d"])).to.be.revertedWithCustomError(
        tagMethods,
        "TooManyTags",
      );
      await expect(fixture.createArena(["x".repeat(32), "a", "b"])).to.not.be.reverted;
    });

    it("reverts for an invalid arena id", async function () {
      const { pixelClash } = await Fixture.load();
      await expect(pixelClash.getArenaTags(1)).to.be.revertedWithCustomError(
        pixelClash,
        "InvalidArenaId",
      );
    });
  });

  describe("arena parameters", function () {
    it("enforces the fixed grid size and bounded fields", async function () {
      const fixture = await Fixture.load();
      const arenaMethods = await ethers.getContractAt("ArenaMethods", ethers.ZeroAddress);
      for (const overrides of [
        { gridSize: 1_000 },
        { gridSize: 20_000 },
        { teamAName: "a".repeat(65) },
        { teamBLogo: "🔥".repeat(17) },
        { maxDuration: MAX_DURATION + 1n },
      ]) {
        await expect(fixture.createArena([], overrides)).to.be.revertedWithCustomError(
          arenaMethods,
          "InvalidArgument",
        );
      }
      await expect(fixture.createArena([], { teamAName: "a".repeat(64), maxDuration: MAX_DURATION }))
        .to.not.be.reverted;
    });
  });

  describe("paginated views", function () {
    it("tracks active arenas until they are drawn", async function () {
      const fixture = await Fixture.load();
      const { pixelClash } = fixture;
      await fixture.createTestArena();
      await fixture.createTestArena();
      expect(await pixelClash.getActiveArenas(0, 10)).to.deep.equal([[1n, 2n], 2n]);

      await fixture.fill(1);
      await pixelClash.draw(1, { value: ethers.parseEther("1") });
      await fixture.fulfill((await pixelClash.getArenaData(1)).vrfRequestId);
      expect((await pixelClash.getArenaData(1)).state).to.equal(ARENA_STATE_DRAWN);
      expect(await pixelClash.getActiveArenas(0, 10)).to.deep.equal([[2n], 1n]);
    });
  });

  describe("draw recovery", function () {
    it("allows a new draw only after the retry delay and ignores the stale callback", async function () {
      const fixture = await Fixture.load();
      const { pixelClash } = fixture;
      await fixture.createTestArena();
      await fixture.fill(1);
      await pixelClash.draw(1, { value: ethers.parseEther("1") });
      const staleRequestId = (await pixelClash.getArenaData(1)).vrfRequestId;

      await expect(
        pixelClash.draw(1, { value: ethers.parseEther("1") }),
      ).to.be.revertedWithCustomError(pixelClash, "DrawPending");
      await time.increase(VRF_RETRY_DELAY - 10n);
      await expect(
        pixelClash.draw(1, { value: ethers.parseEther("1") }),
      ).to.be.revertedWithCustomError(pixelClash, "DrawPending");
      await time.increase(10n);
      await expect(pixelClash.draw(1, { value: ethers.parseEther("1") })).to.emit(
        pixelClash,
        "VRFRequest",
      );
      const requestId = (await pixelClash.getArenaData(1)).vrfRequestId;
      expect(requestId).to.not.equal(staleRequestId);
      expect(await pixelClash.arenaIdsByVrfRequestId(staleRequestId)).to.equal(0n);

      await fixture.fulfill(staleRequestId);
      expect((await pixelClash.getArenaData(1)).state).to.equal(ARENA_STATE_DRAWING);
      await fixture.fulfill(requestId);
      expect((await pixelClash.getArenaData(1)).state).to.equal(ARENA_STATE_DRAWN);
    });
  });

  describe("packed indexes", function () {
    it("lists each arena once per player, newest first, and per owner", async function () {
      const fixture = await Fixture.load();
      const { creator, player1, pixelClash } = fixture;
      const creatorAddress = await creator.getAddress();
      const player1Address = await player1.getAddress();
      for (let i = 0; i < 5; ++i) await fixture.createTestArena();
      await fixture.fund(player1, 5n * ONE_USDC);
      for (const id of [2, 2, 4, 2, 5]) await fixture.purchasePixels(player1, id, false, 1, null);

      expect(await pixelClash.getArenasByPlayer(player1Address, 0, 10)).to.deep.equal([5n, 4n, 2n]);
      expect(await pixelClash.getArenasByPlayer(player1Address, 1, 1)).to.deep.equal([4n]);
      expect(await pixelClash.getArenaCountByPlayer(player1Address)).to.equal(3n);
      expect(await pixelClash.getUserArenas(creatorAddress, 0, 10)).to.deep.equal([
        5n,
        4n,
        3n,
        2n,
        1n,
      ]);
      expect(await pixelClash.getArenasByPlayer(creatorAddress, 0, 2)).to.deep.equal([5n, 4n]);
    });

    it("reuses tag IDs across arenas and keeps the order of each arena's tags", async function () {
      const fixture = await Fixture.load();
      const { pixelClash } = fixture;
      const tagMethods = await ethers.getContractAt("TagMethods", ethers.ZeroAddress);
      await fixture.createArena(["a", "b", "c"]);
      await fixture.createArena(["c", "a"]);
      await fixture.createArena([]);
      expect(await pixelClash.getArenaTags(2)).to.deep.equal(["c", "a"]);
      expect(await pixelClash.getArenaTags(3)).to.deep.equal([]);
      const [tags, counts, total] = await pixelClash.getTags(0, 10);
      expect(tags).to.deep.equal(["a", "b", "c"]);
      expect(counts).to.deep.equal([2n, 1n, 2n]);
      expect(total).to.equal(3n);
      expect(await pixelClash.getArenasByTag("c", 0, 10)).to.deep.equal([2n, 1n]);
      await expect(fixture.createArena(["b", "b"])).to.be.revertedWithCustomError(
        tagMethods,
        "InvalidTag",
      );
    });

    it("reads packed pixel ranges for both teams and the gap", async function () {
      const fixture = await Fixture.load();
      const { creator, player1, player2, pixelClash } = fixture;
      const creatorAddress = await creator.getAddress();
      const player1Address = await player1.getAddress();
      const player2Address = await player2.getAddress();
      await fixture.createTestArena();
      await fixture.fund(player1, 107n * ONE_USDC);
      await fixture.purchasePixels(player1, 1, false, 100, player2);
      await fixture.purchasePixels(player1, 1, true, 7, null);

      // `Result` is an array, so `.length` would be its number of fields: read via `toObject()`.
      const range = async (index: bigint) => {
        const [r, teamB] = await pixelClash.getPixelRange(1, index);
        const { owner, offset, length, referrer } = r.toObject();
        return [owner, offset, length, referrer, teamB];
      };
      expect(await range(4n)).to.deep.equal([creatorAddress, 0n, 5n, ethers.ZeroAddress, false]);
      expect(await range(104n)).to.deep.equal([player1Address, 5n, 100n, player2Address, false]);
      expect(await range(BigInt(STANDARD_GRID_SIZE) - 6n)).to.deep.equal([
        player1Address,
        5n,
        7n,
        ethers.ZeroAddress,
        true,
      ]);
      const [gap] = await pixelClash.getPixelRange(1, 5_000);
      expect(gap.owner).to.equal(ethers.ZeroAddress);
    });
  });

  describe("top referrers", function () {
    it("always matches a brute-force top 3 over random referrals", async function () {
      const fixture = await Fixture.load();
      const { player1, pixelClash } = fixture;
      const referrers = (await ethers.getSigners()).slice(4, 14);
      await fixture.createTestArena();
      await fixture.fund(player1, 80n * 20n * ONE_USDC);
      const totals = new Map<string, bigint>();
      let seed = 42;
      const random = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
      for (let i = 0; i < 80; ++i) {
        const referrer = referrers[random(referrers.length)];
        const count = BigInt(1 + random(20));
        await fixture.purchasePixels(player1, 1, i % 2 === 0, count, referrer);
        totals.set(referrer.address, (totals.get(referrer.address) ?? 0n) + DISCOUNTED_PIXEL_FEE * count);

        const top = await pixelClash.getTopReferrers(1);
        const expected = [...totals.values()]
          .sort((a, b) => (b > a ? 1 : b < a ? -1 : 0))
          .slice(0, 3);
        // Revenues must be the 3 highest, in order; on ties any of the tied referrers is valid.
        expect(top.map((r) => r.revenue)).to.deep.equal(expected);
        for (const r of top) expect(r.revenue).to.equal(totals.get(r.referrer));
        expect(new Set(top.map((r) => r.referrer)).size).to.equal(top.length);
      }
      for (const [referrer, total] of totals) {
        expect(await pixelClash.getReferralRevenueFrom(1, referrer)).to.equal(total);
      }
    });
  });

  describe("referral codes", function () {
    it("registers a code once per address and resolves it", async function () {
      const { player1, player2, pixelClash } = await Fixture.load();
      const player2Address = await player2.getAddress();
      await expect(pixelClash.connect(player2).registerReferralCode("mario_99"))
        .to.emit(pixelClash, "RegisterReferralCode")
        .withArgs(player2Address, "mario_99");
      expect(await pixelClash.getReferralCodeOwner("mario_99")).to.equal(player2Address);
      expect(await pixelClash.getReferralCode(player2Address)).to.equal("mario_99");
      expect(await pixelClash.getReferralCodeOwner("nobody")).to.equal(ethers.ZeroAddress);

      await expect(
        pixelClash.connect(player2).registerReferralCode("other"),
      ).to.be.revertedWithCustomError(pixelClash, "ReferralCodeAlreadySet");
      await expect(
        pixelClash.connect(player1).registerReferralCode("mario_99"),
      ).to.be.revertedWithCustomError(pixelClash, "ReferralCodeTaken");
    });

    it("rejects codes outside the allowed charset and length", async function () {
      const { player1, pixelClash } = await Fixture.load();
      for (const code of ["ab", "a".repeat(21), "Mario", "ma rio", "mario!", "marìo", "0x"]) {
        await expect(
          pixelClash.connect(player1).registerReferralCode(code),
        ).to.be.revertedWithCustomError(pixelClash, "InvalidReferralCode");
      }
      await expect(pixelClash.connect(player1).registerReferralCode("a-b_0".padEnd(20, "z"))).to
        .not.be.reverted;
    });
  });

  describe("players", function () {
    it("emits referrer and fee, and exposes pixels and withdrawals per player", async function () {
      const fixture = await Fixture.load();
      const { creator, player1, player2, pixelClash } = fixture;
      const creatorAddress = await creator.getAddress();
      const player1Address = await player1.getAddress();
      const player2Address = await player2.getAddress();
      await fixture.createTestArena();
      const count = BigInt(STANDARD_GRID_SIZE) - INITIAL_PIXELS;
      await fixture.fund(player1, DISCOUNTED_PIXEL_FEE * count);
      await expect(
        pixelClash
          .connect(player1)
          .purchasePixelsWithPermit(
            1,
            true,
            count,
            player2Address,
            ethers.MaxUint256,
            0,
            ethers.ZeroHash,
            ethers.ZeroHash,
          ),
      )
        .to.emit(pixelClash, "PurchasePixels")
        .withArgs(player1Address, 1n, true, count, count, player2Address, DISCOUNTED_PIXEL_FEE * count);
      expect(await pixelClash.getPlayerPixels(1, player1Address)).to.deep.equal([0n, count]);
      expect(await pixelClash.getPlayerPixels(1, creatorAddress)).to.deep.equal([5n, 5n]);
      expect(await pixelClash.getPurchaseCount(1)).to.equal(1n);
      expect(await pixelClash.getArenaCountByPlayer(player1Address)).to.equal(1n);
      expect(await pixelClash.getArenaCountByPlayer(creatorAddress)).to.equal(1n);

      await pixelClash.draw(1, { value: ethers.parseEther("1") });
      await fixture.fulfill((await pixelClash.getArenaData(1)).vrfRequestId);
      const prize = await pixelClash.getPrizeFor(1, creatorAddress);
      await pixelClash.connect(creator).withdrawPrize(1);
      expect(await pixelClash.getWithdrawnPrizeAmount(1, creatorAddress)).to.equal(prize);
      expect(await pixelClash.getWithdrawnPrizeAmount(1, player1Address)).to.equal(0n);
    });
  });
});
