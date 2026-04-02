import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { type Signer } from "ethers";

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
    count: number,
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

    const arenaData = await pixelClash.getArenaData(arenaId);
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

    const arenaData = await pixelClash.getArenaData(arenaId);
    const numPixelsPerTeamFromCreation = ARENA_CREATION_FEE / ONE_USDC / 2n;
    expect(arenaData.teamACount).to.equal(numPixelsPerTeamFromCreation);
    expect(arenaData.teamBCount).to.equal(numPixelsPerTeamFromCreation + 1n);

    expect(await pixelClash.protocolRevenue()).to.equal(ARENA_CREATION_FEE);
  });
});
