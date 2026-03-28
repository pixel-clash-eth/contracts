import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@nomiclabs/hardhat-solhint";
import "@openzeppelin/hardhat-upgrades";
import * as dotenv from "dotenv";
import "hardhat-gas-reporter";
import "hardhat-contract-sizer";

dotenv.config();

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
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
    ],
    overrides: {},
  },
  networks: {
    hardhat: {
      chainId: 31337,
      forking: {
        url: process.env.HARDHAT_RPC_ADDRESS!,
        enabled: !!process.env.HARDHAT_RPC_ADDRESS,
        blockNumber: process.env.HARDHAT_FORK_BLOCK
          ? parseInt(process.env.HARDHAT_FORK_BLOCK!, 10)
          : void 0,
      },
    },
    localhost: {
      chainId: 31337,
      url: "https://localhost:8545",
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
    mainnet: {
      chainId: 1,
      url: process.env.HARDHAT_RPC_ADDRESS!,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  gasReporter: {
    enabled: false,
    currency: "USD",
    L1: "ethereum",
  },
  contractSizer: {
    alphaSort: false,
    runOnCompile: false,
  },
};

export default config;
