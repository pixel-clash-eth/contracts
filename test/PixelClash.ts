import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

import { Deployer } from "../scripts/deployer";

import type { MockVRFCoordinator, MockVRFWrapper } from "../typechain-types";

const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const POOL_MANAGER_ADDRESS = "0x000000000004444c5dc75cB358380D2e3dE08A90";

const INVALID_ARENA_ID = 0;

describe("PixelClash", function () {
  async function deployFixture() {
    const deployer = await Deployer.create();

    // Deploy the coordinator mock first so we can create a subscription before the wrapper needs it.
    const mockVRFCoordinator = await deployer.deploy<MockVRFCoordinator>(
      "MockVRFCoordinator",
      100_000_000_000_000_000n, // baseFee: 0.1 LINK in juels
      1_000_000_000n, // gasPrice: 1 gwei
      4_000_000_000_000_000n, // weiPerUnitLink: ~0.004 ETH/LINK
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
      pixelClash,
      pixelToken,
      currencyToken,
      controller,
      governor,
      owner,
      mockVRFCoordinator,
      subscriptionId,
    };
  }

  describe("initial state", function () {
    it("references the correct token contracts", async function () {
      const { pixelClash, pixelToken, currencyToken } = await loadFixture(deployFixture);

      expect(await pixelClash.currencyToken()).to.equal(await currencyToken.getAddress());
      expect(await pixelClash.pixelToken()).to.equal(await pixelToken.getAddress());
    });

    it("has a deployed VRF consumer", async function () {
      const { pixelClash } = await loadFixture(deployFixture);

      expect(await pixelClash.vrfConsumer()).to.not.equal(ethers.ZeroAddress);
    });

    it("references the correct pool manager", async function () {
      const { pixelClash } = await loadFixture(deployFixture);

      expect(await pixelClash.poolManager()).to.equal(POOL_MANAGER_ADDRESS);
    });

    it("is not paused", async function () {
      const { pixelClash } = await loadFixture(deployFixture);

      expect(await pixelClash.paused()).to.be.false;
    });

    it("transfers ownership to the controller after governance deployment", async function () {
      const { pixelClash, controller } = await loadFixture(deployFixture);

      expect(await pixelClash.owner()).to.equal(await controller.getAddress());
    });

    it("has no arenas", async function () {
      const { pixelClash } = await loadFixture(deployFixture);

      await expect(pixelClash.getArenaData(INVALID_ARENA_ID)).to.be.revertedWithCustomError(
        pixelClash,
        "InvalidArenaId",
      );
      await expect(pixelClash.getArenaData(1)).to.be.revertedWithCustomError(
        pixelClash,
        "InvalidArenaId",
      );
    });

    it("computes the arena creation fee from the currency token decimals", async function () {
      const { pixelClash } = await loadFixture(deployFixture);

      // ARENA_CREATION_FEE = 2000 cents ($20); USDC has 6 decimals.
      // fee = (2000 * 10^6) / 100 = 20 * 10^6
      expect(await pixelClash.arenaCreationFee()).to.equal(ethers.parseUnits("20", 6));
    });
  });
});
