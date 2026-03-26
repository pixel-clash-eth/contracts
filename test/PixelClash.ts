import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

import { Deployer } from "../scripts/deployer";

import type { MockToken, MockVRFCoordinator, MockVRFWrapper } from "../typechain-types";

const CHAIN_LINK_BASE_FEE = 100_000_000_000_000_000n; // 0.1 LINK in juels
const CHAIN_LINK_GAS_PRICE = 1_000_000_000n; // 1 gwei
const CHAIN_LINK_WEI_PER_LINK_UNIT = 4_000_000_000_000_000n; // ~0.004 ETH/LINK

const POOL_MANAGER_ADDRESS = "0x000000000004444c5dc75cB358380D2e3dE08A90";

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
    process.env.UNISWAP_V4_POOL_MANAGER = POOL_MANAGER_ADDRESS;
    process.env.PIXEL_POOL_FEE = "3000";
    process.env.PIXEL_POOL_TICK_SPACING = "60";

    const pixelToken = await deployer.deployToken();
    const pixelClash = await deployer.deployPixelClash(pixelToken);
    const [controller, governor] = await deployer.deployGovernance(pixelToken, pixelClash);

    return {
      owner,
      mockVRFCoordinator,
      subscriptionId,
      currencyToken,
      pixelToken,
      pixelClash,
      controller,
      governor,
    };
  }

  it("initial state", async function () {
    const { currencyToken, pixelToken, pixelClash, controller } = await loadFixture(deployFixture);
    expect(await pixelClash.owner()).to.equal(await controller.getAddress());
    expect(await pixelClash.paused()).to.be.false;
    expect(await pixelClash.currencyToken()).to.equal(await currencyToken.getAddress());
    expect(await pixelClash.pixelToken()).to.equal(await pixelToken.getAddress());
    expect(await pixelClash.vrfConsumer()).to.not.equal(ethers.ZeroAddress);
    expect(await pixelClash.poolManager()).to.equal(POOL_MANAGER_ADDRESS);
    expect(await pixelClash.arenaCreationFee()).to.equal(20n * ONE_USDC);
    await expect(pixelClash.getArenaData(INVALID_ARENA_ID)).to.be.revertedWithCustomError(
      pixelClash,
      "InvalidArenaId",
    );
    await expect(pixelClash.getArenaData(1)).to.be.revertedWithCustomError(
      pixelClash,
      "InvalidArenaId",
    );
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
    expect(arenaData.revenue).to.equal(creationFee);
    expect(arenaData.balance).to.equal(creationFee);

    const numPixelsPerTeam = creationFee / pixelFee / 2n;
    expect(arenaData.teamACount).to.equal(numPixelsPerTeam);
    expect(arenaData.teamBCount).to.equal(numPixelsPerTeam);
  });
});
