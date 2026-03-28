import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

import { Deployer } from "../scripts/deployer";

import type { MockToken, MockVRFCoordinator, MockVRFWrapper } from "../typechain-types";

const CHAIN_LINK_BASE_FEE = 100_000_000_000_000_000n; // 0.1 LINK in juels
const CHAIN_LINK_GAS_PRICE = 1_000_000_000n; // 1 gwei
const CHAIN_LINK_WEI_PER_LINK_UNIT = 4_000_000_000_000_000n; // ~0.004 ETH/LINK

const UNISWAP_V3_POOL = "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640";

const INVALID_ARENA_ID = 0;

const ONE_USDC = 1_000_000n; // 1 USDC (6 decimals, matching real USDC)

const STANDARD_GRID_SIZE = 10_000;
const STANDARD_MAX_DURATION = 3600n * 24n * 7n; // 7 days

const ARENA_STATE_OPEN = 0;
const ARENA_STATE_FULL = 1;
const ARENA_STATE_TIMED_OUT = 2;
const ARENA_STATE_DRAWING = 3;
const ARENA_STATE_DRAWN = 4;

describe("PixelClash", function () {
  async function deployFixture() {
    const [, owner] = await ethers.getSigners();
    const deployer = await Deployer.create();

    const currencyToken = await deployer.deploy<MockToken>(
      "MockToken",
      /*decimals=*/ 6,
      owner.address,
    );

    const mockVRFCoordinator = await deployer.deploy<MockVRFCoordinator>(
      "MockVRFCoordinator",
      CHAIN_LINK_BASE_FEE,
      CHAIN_LINK_GAS_PRICE,
      CHAIN_LINK_WEI_PER_LINK_UNIT,
    );
    await mockVRFCoordinator.waitForDeployment();

    const subscriptionId = await (async () => {
      const transaction = await mockVRFCoordinator.createSubscription();
      const createReceipt = await transaction.wait();
      const createLog = createReceipt!.logs
        .map((log) => {
          try {
            return mockVRFCoordinator.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((log) => log?.name === "SubscriptionCreated")!;
      return createLog.args.subId;
    })();
    await mockVRFCoordinator.fundSubscriptionWithNative(subscriptionId, {
      value: ethers.parseEther("10"),
    });

    const mockVRFWrapper = await deployer.deploy<MockVRFWrapper>(
      "MockVRFWrapper",
      /*link=*/ ethers.ZeroAddress,
      /*linkNativeFeed=*/ ethers.ZeroAddress,
      await mockVRFCoordinator.getAddress(),
      subscriptionId,
    );
    await mockVRFWrapper.waitForDeployment();

    await mockVRFCoordinator.addConsumer(subscriptionId, await mockVRFWrapper.getAddress());

    process.env.OWNER_ADDRESS = owner.address;
    process.env.CURRENCY_TOKEN = await currencyToken.getAddress();
    process.env.CHAIN_LINK_VRF_WRAPPER = await mockVRFWrapper.getAddress();
    process.env.UNISWAP_V3_POOL = UNISWAP_V3_POOL;

    const pixelToken = await deployer.deployToken();
    const pixelClash = await deployer.deployPixelClash(pixelToken);
    const swapGateway = await ethers.getContractAt("SwapGateway", await pixelClash.swapGateway());
    const [controller, governor] = await deployer.deployGovernance(pixelToken, pixelClash);

    return {
      owner,
      mockVRFCoordinator,
      subscriptionId,
      currencyToken,
      pixelToken,
      pixelClash,
      swapGateway,
      controller,
      governor,
    };
  }

  it("initial state", async function () {
    const { currencyToken, pixelToken, pixelClash, swapGateway, controller } =
      await loadFixture(deployFixture);
    expect(await pixelClash.owner()).to.equal(await controller.getAddress());
    expect(await pixelClash.paused()).to.be.false;
    expect(await pixelClash.currencyToken()).to.equal(await currencyToken.getAddress());
    expect(await pixelClash.vrfConsumer()).to.not.equal(ethers.ZeroAddress);
    expect(await pixelClash.arenaCreationFee()).to.equal(20n * ONE_USDC);
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
    const { currencyToken, pixelClash } = await loadFixture(deployFixture);

    const [, , creator] = await ethers.getSigners();

    const creationFee = 20n * ONE_USDC;
    await currencyToken.connect(creator).mint(creationFee);

    await currencyToken.connect(creator).approve(await pixelClash.getAddress(), creationFee);

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
    expect(arenaData.owner).to.equal(creator.address);
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

    const numPixelsPerTeam = creationFee / pixelFee / 2n;
    expect(arenaData.teamACount).to.equal(numPixelsPerTeam);
    expect(arenaData.teamBCount).to.equal(numPixelsPerTeam);

    expect(await pixelClash.protocolRevenue()).to.equal(creationFee);
  });

  it("purchase pixel in team A", async function () {
    const { currencyToken, pixelClash } = await loadFixture(deployFixture);

    const [, , creator, player] = await ethers.getSigners();

    const creationFee = 20n * ONE_USDC;
    await currencyToken.connect(creator).mint(creationFee);
    await currencyToken.connect(creator).approve(await pixelClash.getAddress(), creationFee);

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

    await currencyToken.connect(player).mint(pixelFee);
    await currencyToken.connect(player).approve(await pixelClash.getAddress(), pixelFee);

    const arenaId = 1;
    const teamB = false;
    await pixelClash
      .connect(player)
      .purchasePixelsWithPermit(
        arenaId,
        teamB,
        1,
        ethers.ZeroAddress,
        ethers.MaxUint256,
        0,
        ethers.ZeroHash,
        ethers.ZeroHash,
      );

    const arenaData = await pixelClash.getArenaData(arenaId);
    const numPixelsPerTeamFromCreation = creationFee / pixelFee / 2n;
    expect(arenaData.teamACount).to.equal(numPixelsPerTeamFromCreation + 1n);
    expect(arenaData.teamBCount).to.equal(numPixelsPerTeamFromCreation);

    expect(await pixelClash.protocolRevenue()).to.equal(creationFee);
  });
});
