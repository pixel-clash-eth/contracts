import { network } from "hardhat";

async function main() {
  await network.provider.send("hardhat_reset");
  console.log("Local Hardhat state reset. Restart or run local:deploy to create a new manifest.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
