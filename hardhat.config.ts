import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-verify";
import "@nomiclabs/hardhat-solhint";
import "@openzeppelin/hardhat-upgrades";
import * as dotenv from "dotenv";
import "hardhat-gas-reporter";
import "hardhat-contract-sizer";

dotenv.config();

const forkUrl = process.env.HARDHAT_RPC_ADDRESS;
const forkBlock = process.env.HARDHAT_FORK_BLOCK;

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
    overrides: {
      // PixelClash is mostly glue code around the ArenaMethods/TagMethods libraries, which keep the
      // high `runs` value above. A lower value here keeps it below the 24 KiB EIP-170 limit.
      "contracts/PixelClash.sol": {
        version: "0.8.28",
        settings: {
          optimizer: {
            enabled: true,
            runs: 10_000,
          },
          debug: {
            revertStrings: "strip",
          },
          evmVersion: "cancun",
          viaIR: true,
        },
      },
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
      hardfork: "cancun",
      forking: forkUrl ? {
        url: forkUrl,
        blockNumber: forkBlock ? Number.parseInt(forkBlock, 10) : undefined,
      } : undefined,
    },
    localhost: {
      chainId: 31337,
      url: "http://127.0.0.1:8545",
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
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY!,
  },
};

export default config;
