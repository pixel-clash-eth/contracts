import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ethers, network } from "hardhat";

async function main() {
  const manifest = JSON.parse(await readFile(join(process.cwd(), "local-deployment.json"), "utf8"));
  const arenaId = BigInt(process.env.ARENA_ID ?? "1");
  const randomWord = BigInt(process.env.RANDOM_WORD ?? "0");
  const pixelClash = await ethers.getContractAt("PixelClash", manifest.pixelClash);
  const arena = await pixelClash.getArenaData(arenaId);
  if (arena.vrfRequestId === 0n) throw new Error(`Arena ${arenaId} has no VRF request`);

  await network.provider.send("hardhat_mine", ["0xa"]);
  const coordinator = await ethers.getContractAt("MockVRFCoordinator", manifest.vrfCoordinator);
  await coordinator.fulfillRandomWordsWithOverride(arena.vrfRequestId, manifest.vrfWrapper, [randomWord]);
  console.log(`Fulfilled arena ${arenaId} with random word ${randomWord}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
