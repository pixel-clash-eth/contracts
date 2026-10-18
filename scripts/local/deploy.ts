import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ethers, network, upgrades } from "hardhat";

const BASE_FEE = 100_000_000_000_000_000n;
const GAS_PRICE = 1_000_000_000n;
const WEI_PER_LINK = 4_000_000_000_000_000n;
const POOL_LIQUIDITY = 10n ** 18n;

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set in SmartContracts/.env`);
  return value;
}

async function main() {
  await network.provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x0"]);
  const [owner] = await ethers.getSigners();
  const currency = await ethers.deployContract("MockToken", [18, owner.address]);
  const pixel = await ethers.deployContract("MockToken", [18, owner.address]);
  const coordinator = await ethers.deployContract("MockVRFCoordinator", [BASE_FEE, GAS_PRICE, WEI_PER_LINK]);
  await Promise.all([currency.waitForDeployment(), pixel.waitForDeployment(), coordinator.waitForDeployment()]);

  const subscriptionReceipt = await (await coordinator.createSubscription()).wait();
  const subscriptionLog = subscriptionReceipt!.logs
    .map((log) => {
      try {
        return coordinator.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((log) => log?.name === "SubscriptionCreated");
  if (!subscriptionLog) throw new Error("SubscriptionCreated event not found");
  const subscriptionId = subscriptionLog.args.subId;

  await coordinator.fundSubscriptionWithNative(subscriptionId, { value: ethers.parseEther("10") });
  const wrapper = await ethers.deployContract("MockVRFWrapper", [
    ethers.ZeroAddress,
    ethers.ZeroAddress,
    await coordinator.getAddress(),
    subscriptionId,
  ]);
  await wrapper.waitForDeployment();
  await coordinator.addConsumer(subscriptionId, await wrapper.getAddress());
  await wrapper.setConfig(60_000, 52_000, 52_000, 1_000, 0, 0, ethers.ZeroHash, 1, 3600, WEI_PER_LINK, 500_000, 100_000);

  const factoryAddress = required("UNISWAP_V3_FACTORY");
  const positionManagerAddress = required("UNISWAP_V3_POSITION_MANAGER");
  const routerAddress = required("UNISWAP_V3_ROUTER");
  const fee = Number.parseInt(required("UNISWAP_V3_POOL_FEE"), 10);
  const poolCreator = await ethers.deployContract("PoolCreatorHelper", [factoryAddress, positionManagerAddress]);
  await poolCreator.waitForDeployment();
  await currency.mint(POOL_LIQUIDITY);
  await pixel.mint(POOL_LIQUIDITY);
  await currency.approve(await poolCreator.getAddress(), POOL_LIQUIDITY);
  await pixel.approve(await poolCreator.getAddress(), POOL_LIQUIDITY);
  await poolCreator.createAndSeed(await currency.getAddress(), await pixel.getAddress(), fee, POOL_LIQUIDITY);
  await network.provider.send("evm_increaseTime", [1801]);
  await network.provider.send("evm_mine");

  const factory = new ethers.Contract(factoryAddress, ["function getPool(address,address,uint24) view returns (address)"], ethers.provider);
  const pool = await factory.getPool(await currency.getAddress(), await pixel.getAddress(), fee);
  if (pool === ethers.ZeroAddress) throw new Error("Uniswap V3 pool was not created");

  const arenaMethods = await ethers.deployContract("ArenaMethods");
  await arenaMethods.waitForDeployment();
  const tagMethods = await ethers.deployContract("TagMethods");
  await tagMethods.waitForDeployment();
  const gateway = await ethers.deployContract("SwapGateway", [await currency.getAddress(), await pixel.getAddress(), routerAddress, pool]);
  await gateway.waitForDeployment();
  const pixelClashFactory = await ethers.getContractFactory("PixelClash", {
    libraries: {
      ArenaMethods: await arenaMethods.getAddress(),
      TagMethods: await tagMethods.getAddress(),
    },
  });
  const pixelClash = await upgrades.deployProxy(
    pixelClashFactory,
    [owner.address, await currency.getAddress(), await wrapper.getAddress(), await gateway.getAddress()],
    { kind: "uups", unsafeAllow: ["external-library-linking"] },
  );
  await pixelClash.waitForDeployment();
  await gateway.transferOwnership(await pixelClash.getAddress());

  const manifest = {
    chainId: 31337,
    deployer: owner.address,
    pixelClash: await pixelClash.getAddress(),
    currencyToken: await currency.getAddress(),
    pixelToken: await pixel.getAddress(),
    arenaMethods: await arenaMethods.getAddress(),
    tagMethods: await tagMethods.getAddress(),
    swapGateway: await gateway.getAddress(),
    vrfCoordinator: await coordinator.getAddress(),
    vrfWrapper: await wrapper.getAddress(),
    uniswapPool: pool,
  };
  const manifestPath = join(process.cwd(), "local-deployment.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
