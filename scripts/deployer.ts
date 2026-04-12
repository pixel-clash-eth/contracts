import type { AbstractSigner, BaseContract } from "ethers";
import { ethers, upgrades } from "hardhat";

import type { PixelClash, SwapGateway } from "../typechain-types";

import { requireEnv } from "./utils";

interface DeployOptions {
  name: string;
  libraries?: { [name: string]: string };
}

export class Deployer {
  private constructor(private readonly _account: AbstractSigner) {}

  public static async create(): Promise<Deployer> {
    const signers = await ethers.getSigners();
    return new Deployer(signers[0]);
  }

  public async getAddress(): Promise<string> {
    return await this._account.getAddress();
  }

  public async deploy<Contract extends BaseContract>(
    options: string | DeployOptions,
    ...args: any[]
  ): Promise<Contract> {
    let contractName;
    let libraries = {};
    switch (typeof options) {
      case "string":
        contractName = options;
        break;
      case "object":
        contractName = options.name;
        libraries = options.libraries || {};
        break;
      default:
        throw new Error("invalid deploy options");
    }
    const factory = await ethers.getContractFactory(contractName, { libraries });
    const contract = await factory.deploy(...args);
    await contract.waitForDeployment();
    return contract as Contract;
  }

  public async deployPixelClash(): Promise<PixelClash> {
    const currencyTokenAddress = requireEnv("CURRENCY_TOKEN");
    const pixelTokenAddress = requireEnv("PIXEL_TOKEN");
    const vrfWrapperAddress = requireEnv("CHAIN_LINK_VRF_WRAPPER");
    const swapRouterAddress = requireEnv("UNISWAP_V3_ROUTER");
    const swapPoolAddress = requireEnv("UNISWAP_V3_POOL");

    const arenaMethods = await this.deploy("ArenaMethods");
    const arenaMethodsAddress = await arenaMethods.getAddress();
    console.log(`ArenaMethods:  ${arenaMethodsAddress}`);

    const swapGateway = await this.deploy<SwapGateway>(
      "SwapGateway",
      currencyTokenAddress,
      pixelTokenAddress,
      swapRouterAddress,
      swapPoolAddress,
    );

    const PixelClashFactory = await ethers.getContractFactory("PixelClash", {
      libraries: {
        ArenaMethods: arenaMethodsAddress,
      },
    });
    const pixelClash = await upgrades.deployProxy(
      PixelClashFactory,
      [
        await this.getAddress(),
        currencyTokenAddress,
        vrfWrapperAddress,
        await swapGateway.getAddress(),
      ],
      {
        kind: "uups",
        unsafeAllow: ["external-library-linking"],
      },
    );
    await pixelClash.waitForDeployment();

    console.log(`PixelClash:    ${await pixelClash.getAddress()}`);
    return pixelClash;
  }
}
