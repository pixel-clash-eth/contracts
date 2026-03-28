import type { AbstractSigner, BaseContract } from "ethers";
import { ethers, upgrades } from "hardhat";

import type { PixelClash, PixelController, PixelGovernor, PixelToken } from "../typechain-types";

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

  public async deployToken(): Promise<PixelToken> {
    const ownerAddress = requireEnv("OWNER_ADDRESS");
    const token = await this.deploy<PixelToken>("PixelToken", ownerAddress);
    console.log(`PixelToken:           ${await token.getAddress()}`);
    return token;
  }

  public async deployPixelClash(pixelToken: PixelToken): Promise<PixelClash> {
    const currencyTokenAddress = requireEnv("CURRENCY_TOKEN");
    const vrfWrapperAddress = requireEnv("CHAIN_LINK_VRF_WRAPPER");
    const swapRouterAddress = requireEnv("UNISWAP_V3_SWAP_ROUTER");
    const swapPoolAddress = requireEnv("UNISWAP_V3_SWAP_POOL");
    const pixelTokenAddress = await pixelToken.getAddress();

    const arenaMethods = await this.deploy("ArenaMethods");
    const arenaMethodsAddress = await arenaMethods.getAddress();
    console.log(`ArenaMethods:         ${arenaMethodsAddress}`);

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
        pixelTokenAddress,
        vrfWrapperAddress,
        swapRouterAddress,
        swapPoolAddress,
      ],
      {
        kind: "uups",
        unsafeAllow: ["external-library-linking"],
      },
    );
    await pixelClash.waitForDeployment();

    console.log(`PixelClash:           ${await pixelClash.getAddress()}`);
    return pixelClash;
  }

  public async deployGovernance(
    pixelToken: PixelToken,
    pixelClash: PixelClash,
  ): Promise<[PixelController, PixelGovernor]> {
    const ownerAddress = requireEnv("OWNER_ADDRESS");

    const controller = await this.deploy<PixelController>(
      "PixelController",
      await pixelClash.getAddress(),
      /*proposers=*/ [],
      /*executors=*/ [],
      /*admin=*/ await this.getAddress(),
    );
    const controllerAddress = await controller.getAddress();
    console.log(`PixelController:      ${controllerAddress}`);

    await (await pixelClash.transferOwnership(controllerAddress)).wait();
    console.log("PixelClash ownership → PixelController");

    const governor = await this.deploy<PixelGovernor>(
      "PixelGovernor",
      await pixelToken.getAddress(),
      controllerAddress,
    );
    const governorAddress = await governor.getAddress();
    console.log(`PixelGovernor:        ${governorAddress}`);

    const PROPOSER_ROLE = await controller.PROPOSER_ROLE();
    const EXECUTOR_ROLE = await controller.EXECUTOR_ROLE();
    const CANCELLER_ROLE = await controller.CANCELLER_ROLE();
    const ADMIN_ROLE = await controller.DEFAULT_ADMIN_ROLE();

    await (await controller.grantRole(PROPOSER_ROLE, governorAddress)).wait();
    await (await controller.grantRole(EXECUTOR_ROLE, governorAddress)).wait();
    await (await controller.grantRole(CANCELLER_ROLE, governorAddress)).wait();
    await (await controller.grantRole(ADMIN_ROLE, ownerAddress)).wait();

    await (await controller.renounceRole(ADMIN_ROLE, await this.getAddress())).wait();
    console.log("Deployer admin role renounced");

    return [controller, governor];
  }
}
