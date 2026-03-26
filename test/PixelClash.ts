import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

import { Deployer } from "../scripts/deployer";

import type { MockVRFCoordinator, MockVRFWrapper } from "../typechain-types";

const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const CHAIN_LINK_BASE_FEE = 100_000_000_000_000_000n; // 0.1 LINK in juels
const CHAIN_LINK_GAS_PRICE = 1_000_000_000n; // 1 gwei
const CHAIN_LINK_WEI_PER_LINK_UNIT = 4_000_000_000_000_000n; // ~0.004 ETH/LINK

const POOL_MANAGER_ADDRESS = "0x000000000004444c5dc75cB358380D2e3dE08A90";

const INVALID_ARENA_ID = 0;

const ONE_USDC = 1_000_000n;

describe("PixelClash", function () {
  async function deployFixture() {
    const deployer = await Deployer.create();

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

    const currencyToken = await ethers.getContractAt("IERC20", USDC_ADDRESS);

    const [, owner] = await ethers.getSigners();
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
    const { pixelClash, pixelToken, controller } = await loadFixture(deployFixture);
    expect(await pixelClash.owner()).to.equal(await controller.getAddress());
    expect(await pixelClash.paused()).to.be.false;
    expect(await pixelClash.currencyToken()).to.equal(USDC_ADDRESS);
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
});
