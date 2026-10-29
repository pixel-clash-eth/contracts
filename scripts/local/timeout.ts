import { network } from "hardhat";

async function main() {
  const seconds = Number.parseInt(process.env.SECONDS ?? "604801", 10);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error("SECONDS must be a positive integer");
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
  console.log(`Advanced local time by ${seconds} seconds`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
