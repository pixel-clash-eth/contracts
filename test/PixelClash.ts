import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

import { Deployer } from "../scripts/deployer";

describe("PixelClash", function () {
  /// Deploys the full contract suite using the production Deployer, substituting external
  /// dependencies (VRF wrapper, pool manager, currency token) with lightweight test doubles.
  async function deployFixture() {
    const [, owner] = await ethers.getSigners();

    // MockVRFWrapper satisfies the one call made during VRFConsumer construction: `link()`.
    const mockVRFWrapper = await (await ethers.getContractFactory("MockVRFWrapper")).deploy();
    await mockVRFWrapper.waitForDeployment();

    // Use the real USDC contract from the mainnet fork as the currency token.
    const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
    const currencyToken = await ethers.getContractAt("IERC20", USDC_ADDRESS);

    // Pool manager is only stored during initialisation; no functions are called on it at
    // deployment time, so any address works.
    const mockPoolManagerAddress = owner.address;

    process.env.OWNER_ADDRESS = owner.address;
    process.env.CURRENCY_TOKEN = await currencyToken.getAddress();
    process.env.CHAIN_LINK_VRF_WRAPPER = await mockVRFWrapper.getAddress();
    process.env.UNISWAP_V4_POOL_MANAGER = mockPoolManagerAddress;
    process.env.PIXEL_POOL_FEE = "3000";
    process.env.PIXEL_POOL_TICK_SPACING = "60";

    const deployer = await Deployer.create();
    const pixelToken = await deployer.deployToken();
    const pixelClash = await deployer.deployPixelClash(pixelToken);
    const [controller, governor] = await deployer.deployGovernance(pixelToken, pixelClash);

    return { pixelClash, pixelToken, currencyToken, controller, governor, owner };
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
      const { pixelClash, owner } = await loadFixture(deployFixture);

      expect(await pixelClash.poolManager()).to.equal(owner.address);
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

      // Arena ID 0 is reserved and intentionally skipped; ID 1 does not exist yet.
      await expect(pixelClash.getArenaData(0)).to.be.revertedWithCustomError(
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
