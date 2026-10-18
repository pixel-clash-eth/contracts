import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Signer } from "ethers";
import { ethers, network } from "hardhat";

const GRID_SIZE = 10_000n;
const INITIAL_PIXELS = 10n;
const PURCHASE_COUNT = GRID_SIZE - INITIAL_PIXELS;

type PermitToken = {
  nonces(owner: string): Promise<bigint>;
  name(): Promise<string>;
  getAddress(): Promise<string>;
};

async function permit(token: PermitToken, signer: Signer, spender: string, value: bigint) {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const owner = await signer.getAddress();
  const nonce = await token.nonces(owner);
  const signature = ethers.Signature.from(await signer.signTypedData(
    {
      name: await token.name(),
      version: "1",
      chainId: 31337,
      verifyingContract: await token.getAddress(),
    },
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

async function main() {
  const manifest = JSON.parse(await readFile(join(process.cwd(), "local-deployment.json"), "utf8"));
  const [, creator, buyer] = await ethers.getSigners();
  const token = await ethers.getContractAt("MockToken", manifest.currencyToken);
  const pixelClash = await ethers.getContractAt("PixelClash", manifest.pixelClash);
  const pixelFee = ethers.parseUnits("1", 18);
  const creationFee = await pixelClash.arenaCreationFee(pixelFee);

  await token.connect(creator).mint(creationFee);
  const createPermit = await permit(token, creator, manifest.pixelClash, creationFee);
  await pixelClash.connect(creator).createArenaWithPermit(
    {
      teamAName: "Alpha",
      teamALogo: "A",
      teamALogoCid: ethers.ZeroHash,
      teamAColor: 0xff0000,
      teamBName: "Beta",
      teamBLogo: "B",
      teamBLogoCid: ethers.ZeroHash,
      teamBColor: 0x0000ff,
      gridSize: GRID_SIZE,
      pixelFee,
      maxDuration: 7n * 24n * 60n * 60n,
    },
    ["local"],
    createPermit.deadline,
    createPermit.signature.v,
    createPermit.signature.r,
    createPermit.signature.s,
  );

  const purchaseFee = pixelFee * PURCHASE_COUNT;
  await token.connect(buyer).mint(purchaseFee);
  const purchasePermit = await permit(token, buyer, manifest.pixelClash, purchaseFee);
  await pixelClash.connect(buyer).purchasePixelsWithPermit(
    1n,
    false,
    PURCHASE_COUNT,
    ethers.ZeroAddress,
    purchasePermit.deadline,
    purchasePermit.signature.v,
    purchasePermit.signature.r,
    purchasePermit.signature.s,
  );
  if ((await pixelClash.getArenaData(1n)).state !== 1n) throw new Error("Arena did not become FULL");

  await pixelClash.connect(creator).draw(1n, { value: await pixelClash.getDrawPrice() });
  const requestId = (await pixelClash.getArenaData(1n)).vrfRequestId;
  await network.provider.send("hardhat_mine", ["0xa"]);
  const coordinator = await ethers.getContractAt("MockVRFCoordinator", manifest.vrfCoordinator);
  await coordinator.fulfillRandomWordsWithOverride(requestId, manifest.vrfWrapper, [0n]);
  if ((await pixelClash.getArenaData(1n)).state !== 4n) throw new Error("Arena did not become DRAWN");

  await pixelClash.connect(creator).withdrawPrize(1n);
  try {
    await pixelClash.connect(creator).withdrawPrize(1n);
    throw new Error("Second prize withdrawal unexpectedly succeeded");
  } catch (error) {
    if (error instanceof Error && error.message === "Second prize withdrawal unexpectedly succeeded") throw error;
  }
  console.log("Local lifecycle smoke test passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
