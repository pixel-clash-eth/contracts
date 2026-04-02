import { Deployer } from "./deployer";
import { requireEnv } from "./utils";

async function main() {
  const ownerAddress = requireEnv("OWNER_ADDRESS");

  const deployer = await Deployer.create();
  console.log(`Deployer: ${await deployer.getAddress()}`);
  console.log(`Owner:    ${ownerAddress}`);

  const pixelClash = await deployer.deployPixelClash();
  console.log(`Deployed successfully at ${await pixelClash.getAddress()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
