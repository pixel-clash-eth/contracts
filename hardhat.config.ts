import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import * as dotenv from "dotenv";
import "hardhat-gas-reporter";

dotenv.config();

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 1_000_000,
      },
      debug: {
        revertStrings: "strip",
      },
      evmVersion: "cancun",
      viaIR: true,
    },
  },
  networks: {
    mainnet: {
      chainId: 1,
      url: process.env.RPC_ADDRESS!,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
    test: {
      chainId: 31337,
      url: "https://localhost:8545",
    },
  },
  gasReporter: {
    currency: "USD",
    L1: "ethereum",
  },
};

export default config;
