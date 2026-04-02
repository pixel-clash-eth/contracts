import { loadFixture, mine } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import type { BigNumberish, Signer } from "ethers";

import { Deployer } from "../scripts/deployer";

import type {
  ERC20Burnable,
  MockToken,
  MockVRFCoordinator,
  MockVRFWrapper,
  PixelClash,
  SwapGateway,
} from "../typechain-types";

const CHAIN_LINK_BASE_FEE = 100_000_000_000_000_000n; // 0.1 LINK in juels
const CHAIN_LINK_GAS_PRICE = 1_000_000_000n; // 1 gwei
const CHAIN_LINK_WEI_PER_LINK_UNIT = 4_000_000_000_000_000n; // ~0.004 ETH/LINK

const UNISWAP_V3_POOL = "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640";

const INVALID_ARENA_ID = 0;

const ONE_USDC = 1_000_000n; // 1 USDC (6 decimals, matching real USDC)
const ARENA_CREATION_FEE = 20n * ONE_USDC;

const STANDARD_GRID_SIZE = 10_000;
const STANDARD_MAX_DURATION = 3600n * 24n * 7n; // 7 days

const ARENA_STATE_OPEN = 0;
const ARENA_STATE_FULL = 1;
const ARENA_STATE_TIMED_OUT = 2;
const ARENA_STATE_DRAWING = 3;
const ARENA_STATE_DRAWN = 4;

class Fixture {
  private static async _deploy(): Promise<Fixture> {
    const [owner, creator, player1, player2] = await ethers.getSigners();
    const deployer = await Deployer.create();

    const currencyToken = await deployer.deploy<MockToken>(
      "MockToken",
      /*decimals=*/ 6,
      owner.address,
    );

    const pixelToken = await ethers.getContractAt("ERC20Burnable", process.env.PIXEL_TOKEN!);

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

    process.env.OWNER_ADDRESS = owner.address;
    process.env.CURRENCY_TOKEN = await currencyToken.getAddress();
    process.env.CHAIN_LINK_VRF_WRAPPER = await mockVRFWrapper.getAddress();
    process.env.UNISWAP_V3_POOL = UNISWAP_V3_POOL;

    const pixelClash = await deployer.deployPixelClash();
    const swapGateway = await ethers.getContractAt("SwapGateway", await pixelClash.swapGateway());

    return new Fixture(
      owner,
      [creator, player1, player2],
      mockVrfCoordinator,
      subscriptionId,
      currencyToken,
      pixelToken,
      pixelClash,
      swapGateway,
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

  public async createTestArena(): Promise<void> {
    const { creator } = this;

    await this._currencyToken.connect(creator).mint(ARENA_CREATION_FEE);
    await this._currencyToken
      .connect(creator)
      .approve(await this._pixelClash.getAddress(), ARENA_CREATION_FEE);

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

    await this._pixelClash
      .connect(creator)
      .createArenaWithPermit(params, ethers.MaxUint256, 0, ethers.ZeroHash, ethers.ZeroHash);
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
    const { owner, currencyToken, pixelToken, pixelClash, swapGateway } = await Fixture.load();
    expect(await pixelClash.owner()).to.equal(await owner.getAddress());
    expect(await pixelClash.paused()).to.be.false;
    expect(await pixelClash.currencyToken()).to.equal(await currencyToken.getAddress());
    expect(await pixelClash.vrfConsumer()).to.not.equal(ethers.ZeroAddress);
    expect(await pixelClash.arenaCreationFee()).to.equal(ARENA_CREATION_FEE);
    await expect(pixelClash.getArenaData(INVALID_ARENA_ID)).to.be.revertedWithCustomError(
      pixelClash,
      "InvalidArenaId",
    );
    await expect(pixelClash.getArenaData(1)).to.be.revertedWithCustomError(
      pixelClash,
      "InvalidArenaId",
    );
    expect(await swapGateway.inputToken()).to.equal(await currencyToken.getAddress());
    expect(await swapGateway.targetToken()).to.equal(await pixelToken.getAddress());
    expect(await swapGateway.swapRouter()).to.equal(process.env.UNISWAP_V3_ROUTER);
    expect(await swapGateway.swapPool()).to.equal(UNISWAP_V3_POOL);
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
      .createArenaWithPermit(params, ethers.MaxUint256, 0, ethers.ZeroHash, ethers.ZeroHash);

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

    const numPixelsPerTeam = ARENA_CREATION_FEE / pixelFee / 2n;
    expect(arenaData.teamACount).to.equal(numPixelsPerTeam);
    expect(arenaData.teamBCount).to.equal(numPixelsPerTeam);

    expect(await pixelClash.protocolRevenue()).to.equal(ARENA_CREATION_FEE);
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

    const numPixelsPerTeamFromCreation = ARENA_CREATION_FEE / ONE_USDC / 2n;
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

    const numPixelsPerTeamFromCreation = ARENA_CREATION_FEE / ONE_USDC / 2n;
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

    const numPixelsPerTeamFromCreation = ARENA_CREATION_FEE / ONE_USDC / 2n;
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

    const numPixelsPerTeamFromCreation = ARENA_CREATION_FEE / ONE_USDC / 2n;
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

    const numPixelsPerTeamFromCreation = ARENA_CREATION_FEE / ONE_USDC / 2n;
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
    const numPixelsPerTeamFromCreation = ARENA_CREATION_FEE / pixelFee / 2n;
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
    const numPixelsPerTeamFromCreation = ARENA_CREATION_FEE / pixelFee / 2n;
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
    const numPixelsPerTeamFromCreation = ARENA_CREATION_FEE / pixelFee / 2n;
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
    const numPixelsPerTeamFromCreation = ARENA_CREATION_FEE / pixelFee / 2n;
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
    const numPixelsPerTeamFromCreation = ARENA_CREATION_FEE / pixelFee / 2n;
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

    const { creator, player1, player2, currencyToken, pixelClash, mockVrfCoordinator } = fixture;
    const arenaId = 1;
    const pixelFee = ONE_USDC;
    const numPixelsPerTeamFromCreation = ARENA_CREATION_FEE / pixelFee / 2n;
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

    // ── Protocol revenue ──────────────────────────────────────────────────────
    // swapAndBurn reverts (no real Uniswap in tests), so protocolRevenue absorbs:
    //   - ARENA_CREATION_FEE (from createArena)
    //   - arena protocol fee (5% of totalRevenue that isn't covered by WINNER+TEAM+OWNER with no referrers)
    expect(await pixelClash.protocolRevenue()).to.equal(
      ARENA_CREATION_FEE + expectedArenaProtocolFee,
    );
  });
});
