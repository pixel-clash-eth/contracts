import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ethers } from "hardhat";

// Sends local currency tokens to any wallet, eg. one imported in MetaMask that isn't a Hardhat account.
async function main() {
  const address = process.env.ADDRESS;
  if (!address || !ethers.isAddress(address)) throw new Error("Set ADDRESS to the wallet to fund");
  const manifest = JSON.parse(await readFile(join(process.cwd(), "local-deployment.json"), "utf8"));
  const token = await ethers.getContractAt("MockToken", manifest.currencyToken);
  const amount = ethers.parseUnits(process.env.AMOUNT ?? "1000000", await token.decimals());
  await (await token.mint(amount)).wait();
  await (await token.transfer(address, amount)).wait();
  console.log(`Funded ${address} with ${ethers.formatUnits(amount, await token.decimals())} currency tokens`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
