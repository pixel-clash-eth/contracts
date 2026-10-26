import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Signer } from "ethers";
import { ethers, network } from "hardhat";

const ARENA_COUNT = Number(process.env.COUNT ?? "20");
const PLAYER_COUNT = 9;
const GRID_SIZE = 10_000n;

const TEAMS = [
  ["Lions", "🦁"], ["Tigers", "🐯"], ["Wolves", "🐺"], ["Eagles", "🦅"], ["Sharks", "🦈"],
  ["Dragons", "🐉"], ["Foxes", "🦊"], ["Bears", "🐻"], ["Owls", "🦉"], ["Pandas", "🐼"],
  ["Rockets", "🚀"], ["Pizza", "🍕"], ["Tacos", "🌮"], ["Cats", "🐱"], ["Dogs", "🐶"],
  ["Robots", "🤖"], ["Aliens", "👽"], ["Ghosts", "👻"], ["Unicorns", "🦄"], ["Frogs", "🐸"],
];
const TAGS = ["sport", "food", "animals", "meme", "crypto", "fun", "local", "battle", "gaming", "music"];

const rand = (n: number) => Math.floor(Math.random() * n);
const pick = <T>(items: T[]) => items[rand(items.length)];

async function permit(token: any, signer: Signer, spender: string, value: bigint) {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const owner = await signer.getAddress();
  const nonce = await token.nonces(owner);
  const signature = ethers.Signature.from(await signer.signTypedData(
    { name: await token.name(), version: "1", chainId: 31337, verifyingContract: await token.getAddress() },
    {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    { owner, spender, value, nonce, deadline },
  ));
  return { deadline, signature };
}

// Creates random OPEN arenas (COUNT, 20 by default) and buys a random share of pixels in each from
// several players. The players are random wallets: transactions from the Hardhat accounts would
// advance their nonces behind the back of a wallet that imported them ("nonce too low").
async function main() {
  const manifest = JSON.parse(await readFile(join(process.cwd(), "local-deployment.json"), "utf8"));
  const signers = Array.from({ length: PLAYER_COUNT }, () => ethers.Wallet.createRandom().connect(ethers.provider));
  for (const signer of signers) {
    await network.provider.send("hardhat_setBalance", [signer.address, "0x56BC75E2D63100000"]);
  }
  const token = await ethers.getContractAt("MockToken", manifest.currencyToken);
  const pixelClash = await ethers.getContractAt("PixelClash", manifest.pixelClash);
  const decimals = await token.decimals();

  for (let i = 0; i < ARENA_COUNT; i += 1) {
    const creator = pick(signers);
    const a = rand(TEAMS.length);
    const b = (a + 1 + rand(TEAMS.length - 1)) % TEAMS.length;
    const pixelFee = ethers.parseUnits(pick(["0.1", "0.5", "1", "2", "5"]), decimals);
    const tags = [...TAGS].sort(() => Math.random() - 0.5).slice(0, rand(4));
    const creationFee = await pixelClash.arenaCreationFee(pixelFee);

    await (await token.connect(creator).mint(creationFee)).wait();
    const createPermit = await permit(token, creator, manifest.pixelClash, creationFee);
    await (await pixelClash.connect(creator).createArenaWithPermit(
      {
        teamAName: TEAMS[a][0],
        teamALogo: TEAMS[a][1],
        teamALogoCid: ethers.ZeroHash,
        teamAColor: rand(0x1000000),
        teamBName: TEAMS[b][0],
        teamBLogo: TEAMS[b][1],
        teamBLogoCid: ethers.ZeroHash,
        teamBColor: rand(0x1000000),
        gridSize: GRID_SIZE,
        pixelFee,
        maxDuration: BigInt(1 + rand(30)) * 24n * 60n * 60n,
      },
      tags,
      createPermit.deadline,
      createPermit.signature.v,
      createPermit.signature.r,
      createPermit.signature.s,
    )).wait();
    const arenaId = await pixelClash.getArenaCount();

    // Keep the total well below the grid so the arena stays OPEN.
    let bought = 0n;
    const purchases = 1 + rand(8);
    for (let p = 0; p < purchases; p += 1) {
      const buyer = pick(signers);
      const count = BigInt(1 + rand(600));
      const cost = pixelFee * count;
      await (await token.connect(buyer).mint(cost)).wait();
      const purchasePermit = await permit(token, buyer, manifest.pixelClash, cost);
      await (await pixelClash.connect(buyer).purchasePixelsWithPermit(
        arenaId,
        Math.random() < 0.5,
        count,
        ethers.ZeroAddress,
        purchasePermit.deadline,
        purchasePermit.signature.v,
        purchasePermit.signature.r,
        purchasePermit.signature.s,
      )).wait();
      bought += count;
    }
    console.log(`Arena #${arenaId}: ${TEAMS[a][0]} vs ${TEAMS[b][0]}, ${purchases} purchases, ${bought} pixels`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
