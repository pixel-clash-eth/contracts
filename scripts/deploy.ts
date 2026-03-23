import { ethers, upgrades } from "hardhat";

async function main() {
  // ─── Env validation ──────────────────────────────────────────────────────────
  function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
      throw new Error(`${name} is not set in .env`);
    }
    return value;
  }

  const ownerAddress = requireEnv("OWNER_ADDRESS");
  const currencyTokenAddress = requireEnv("CURRENCY_TOKEN");
  const vrfWrapperAddress = requireEnv("CHAIN_LINK_VRF_WRAPPER");
  const poolManagerAddress = requireEnv("UNISWAP_V4_POOL_MANAGER");
  const poolCurrency0 = requireEnv("POOL_CURRENCY0");
  const poolCurrency1 = requireEnv("POOL_CURRENCY1");
  const poolFee = requireEnv("POOL_FEE");
  const poolTickSpacing = requireEnv("POOL_TICK_SPACING");
  const poolHooks = process.env.POOL_HOOKS ?? ethers.ZeroAddress;

  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Owner:    ${ownerAddress}`);

  // ─── 1. PixelToken ───────────────────────────────────────────────────────────
  const PixelTokenFactory = await ethers.getContractFactory("PixelToken");
  const pixelToken = await PixelTokenFactory.deploy(deployer.address);
  await pixelToken.waitForDeployment();
  const pixelTokenAddress = await pixelToken.getAddress();
  console.log(`PixelToken:      ${pixelTokenAddress}`);

  // ─── 2. PixelClash (UUPS proxy) ──────────────────────────────────────────────
  const swapPoolKey = {
    currency0: poolCurrency0,
    currency1: poolCurrency1,
    fee: Number(poolFee),
    tickSpacing: Number(poolTickSpacing),
    hooks: poolHooks,
  };

  const PixelClashFactory = await ethers.getContractFactory("PixelClash");
  const pixelClash = await upgrades.deployProxy(
    PixelClashFactory,
    [
      deployer.address, // initialOwner — transferred to PixelController below
      currencyTokenAddress,
      pixelTokenAddress,
      vrfWrapperAddress,
      poolManagerAddress,
      swapPoolKey,
    ],
    { kind: "uups" },
  );
  await pixelClash.waitForDeployment();
  const pixelClashAddress = await pixelClash.getAddress();
  console.log(`PixelClash:      ${pixelClashAddress}`);

  // ─── 3. PixelController (Timelock) ───────────────────────────────────────────
  // Deployed with deployer as the sole admin so we can grant roles in the next
  // steps before renouncing.
  const PixelControllerFactory = await ethers.getContractFactory("PixelController");
  const controller = await PixelControllerFactory.deploy(
    pixelClashAddress,
    [], // proposers — granted below
    [], // executors — granted below
    deployer.address, // temporary admin
  );
  await controller.waitForDeployment();
  const controllerAddress = await controller.getAddress();
  console.log(`PixelController: ${controllerAddress}`);

  // ─── 4. Transfer PixelClash ownership to PixelController ─────────────────────
  await (await pixelClash.transferOwnership(controllerAddress)).wait();
  console.log("PixelClash ownership → PixelController");

  // ─── 5. PixelGovernor ────────────────────────────────────────────────────────
  const PixelGovernorFactory = await ethers.getContractFactory("PixelGovernor");
  const governor = await PixelGovernorFactory.deploy(pixelTokenAddress, controllerAddress);
  await governor.waitForDeployment();
  const governorAddress = await governor.getAddress();
  console.log(`PixelGovernor:   ${governorAddress}`);

  // ─── 6. Role setup ───────────────────────────────────────────────────────────
  const PROPOSER_ROLE = await controller.PROPOSER_ROLE();
  const EXECUTOR_ROLE = await controller.EXECUTOR_ROLE();
  const CANCELLER_ROLE = await controller.CANCELLER_ROLE();
  const ADMIN_ROLE = await controller.DEFAULT_ADMIN_ROLE();

  // Governor needs PROPOSER_ROLE + CANCELLER_ROLE to queue and cancel proposals
  // through the timelock.
  await (await controller.grantRole(PROPOSER_ROLE, governorAddress)).wait();
  await (await controller.grantRole(CANCELLER_ROLE, governorAddress)).wait();

  // Owner receives proposer, executor, and admin roles as requested.
  await (await controller.grantRole(PROPOSER_ROLE, ownerAddress)).wait();
  await (await controller.grantRole(EXECUTOR_ROLE, ownerAddress)).wait();
  await (await controller.grantRole(ADMIN_ROLE, ownerAddress)).wait();

  // Deployer renounces its temporary admin role — it never held proposer/executor.
  await (await controller.renounceRole(ADMIN_ROLE, deployer.address)).wait();
  console.log("Deployer admin role renounced");

  // ─── Summary ─────────────────────────────────────────────────────────────────
  console.log("\nDeployment complete:");
  console.log(`  PixelToken:      ${pixelTokenAddress}`);
  console.log(`  PixelClash:      ${pixelClashAddress}`);
  console.log(`  PixelController: ${controllerAddress}`);
  console.log(`  PixelGovernor:   ${governorAddress}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
