import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ethers, network } from "hardhat";

// Local stand-in for the Chainlink VRF network: answers every `VRFRequest` with a random word after
// the 10 confirmations a real request waits for. Only meant for the local node, where the VRF
// coordinator is a mock that never answers on its own.

const CONFIRMATIONS = "0xa";
const STATE_DRAWING = 3n;
const STATE_DRAWN = 4n;
// The coordinator doesn't revert when the callback runs out of gas, so a gas estimate can be too low
// for the callback: give it plenty (the callback itself is capped at 1M gas by PixelClash).
const FULFILL_GAS_LIMIT = 5_000_000n;
const POLL_INTERVAL_MS = 1_000;

async function main() {
  const manifest = JSON.parse(await readFile(join(process.cwd(), "local-deployment.json"), "utf8"));
  const pixelClash = await ethers.getContractAt("PixelClash", manifest.pixelClash);

  // A throwaway account sends the fulfillments, so that no wallet account's nonce changes behind the
  // wallet's back.
  const keeper = ethers.Wallet.createRandom().connect(ethers.provider);
  await network.provider.send("hardhat_setBalance", [keeper.address, "0x56BC75E2D63100000"]);
  const coordinator = (await ethers.getContractAt("MockVRFCoordinator", manifest.vrfCoordinator)).connect(keeper);

  let queue = Promise.resolve();
  const fulfill = (arenaId: bigint, requestId: bigint) => {
    queue = queue.then(async () => {
      try {
        await network.provider.send("hardhat_mine", [CONFIRMATIONS]);
        const word = BigInt(`0x${randomBytes(32).toString("hex")}`);
        await (
          await coordinator.fulfillRandomWordsWithOverride(requestId, manifest.vrfWrapper, [word], {
            gasLimit: FULFILL_GAS_LIMIT,
          })
        ).wait();
        const arena = await pixelClash.getArenaData(arenaId);
        if (arena.state !== STATE_DRAWN) throw new Error(`arena still in state ${arena.state}`);
        console.log(`[auto-fulfill] arena ${arenaId}: request ${requestId} fulfilled, winner pixel ${arena.winner}`);
      } catch (error) {
        console.error(`[auto-fulfill] arena ${arenaId}: request ${requestId} failed`, error);
      }
    });
  };

  // Requests submitted before this script started.
  for (let offset = 0n; ; offset += 100n) {
    const [ids] = await pixelClash.getActiveArenas(offset, 100n);
    if (ids.length === 0) break;
    for (const id of ids) {
      const arena = await pixelClash.getArenaData(id);
      if (arena.state === STATE_DRAWING) fulfill(id, arena.vrfRequestId);
    }
  }

  console.log(`[auto-fulfill] watching VRF requests of ${manifest.pixelClash}`);
  let fromBlock = (await ethers.provider.getBlockNumber()) + 1;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const toBlock = await ethers.provider.getBlockNumber();
    if (toBlock < fromBlock) continue;
    for (const event of await pixelClash.queryFilter(pixelClash.filters.VRFRequest(), fromBlock, toBlock)) {
      fulfill(event.args.arenaId, event.args.vrfRequestId);
    }
    fromBlock = toBlock + 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
