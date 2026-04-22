import { ethers, upgrades } from "hardhat";

import { requireEnv } from "./utils";

async function main() {
  const proxyAddress = requireEnv("PIXEL_CLASH_PROXY");

  const signers = await ethers.getSigners();
  const deployer = signers[0];
  console.log(`Deployer: ${await deployer.getAddress()}`);
  console.log(`Proxy:    ${proxyAddress}`);

  const arenaMethods = await (await ethers.getContractFactory("ArenaMethods")).deploy();
  await arenaMethods.waitForDeployment();
  const arenaMethodsAddress = await arenaMethods.getAddress();
  console.log(`ArenaMethods (new): ${arenaMethodsAddress}`);

  const PixelClashFactory = await ethers.getContractFactory("PixelClash", {
    libraries: {
      ArenaMethods: arenaMethodsAddress,
    },
  });

  const pixelClash = await upgrades.upgradeProxy(proxyAddress, PixelClashFactory, {
    kind: "uups",
    unsafeAllow: ["external-library-linking"],
  });
  await pixelClash.waitForDeployment();

  const newImpl = await upgrades.erc1967.getImplementationAddress(proxyAddress);
  console.log(`New implementation: ${newImpl}`);
  console.log("Upgrade complete.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
