import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ethers, network } from "hardhat";

// Points the local PixelClash proxy to a freshly compiled implementation, keeping its state and
// address, so the running frontend and its arenas keep working. Only for changes that don't touch
// the storage layout, eg. new views. A random wallet sends the transactions, so the nonces of the
// accounts imported in a wallet don't move.
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

async function main() {
  const manifest = JSON.parse(await readFile(join(process.cwd(), "local-deployment.json"), "utf8"));
  const deployer = ethers.Wallet.createRandom().connect(ethers.provider);
  await network.provider.send("hardhat_setBalance", [deployer.address, "0x56BC75E2D63100000"]);

  const arenaMethods = await (await ethers.getContractFactory("ArenaMethods", deployer)).deploy();
  await arenaMethods.waitForDeployment();
  const factory = await ethers.getContractFactory("PixelClash", {
    signer: deployer,
    libraries: { ArenaMethods: await arenaMethods.getAddress(), TagMethods: manifest.tagMethods },
  });
  const implementation = await factory.deploy();
  await implementation.waitForDeployment();

  const value = ethers.zeroPadValue(await implementation.getAddress(), 32);
  await network.provider.send("hardhat_setStorageAt", [manifest.pixelClash, IMPLEMENTATION_SLOT, value]);
  console.log(`PixelClash ${manifest.pixelClash} now runs ${await implementation.getAddress()}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
