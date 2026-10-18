import { expect } from "chai";
import { ethers } from "hardhat";

describe("local toolchain", () => {
  it("deploys the 18-decimal EIP-2612 currency mock", async () => {
    const [owner] = await ethers.getSigners();
    const token = await ethers.deployContract("MockToken", [18, owner.address]);

    expect(await token.decimals()).to.equal(18);
    expect(await token.name()).to.equal("MockToken");
    expect(await token.nonces(owner.address)).to.equal(0);
    expect(await token.DOMAIN_SEPARATOR()).to.not.equal(ethers.ZeroHash);
  });
});
