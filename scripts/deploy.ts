import { Deployer } from "./deployer";
import { requireEnv } from "./utils";

async function main() {
  const ownerAddress = requireEnv("OWNER_ADDRESS");

  const deployer = await Deployer.create();
  console.log(`Deployer: ${await deployer.getAddress()}`);
  console.log(`Owner:    ${ownerAddress}`);

  const pixelToken = await deployer.deployToken();
  const pixelClash = await deployer.deployPixelClash(pixelToken);
  const [controller, governor] = await deployer.deployGovernance(pixelToken, pixelClash);

  console.log("\nDeployment complete:");
  console.log(`  PixelToken:      ${await pixelToken.getAddress()}`);
  console.log(`  PixelClash:      ${await pixelClash.getAddress()}`);
  console.log(`  PixelController: ${await controller.getAddress()}`);
  console.log(`  PixelGovernor:   ${await governor.getAddress()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
