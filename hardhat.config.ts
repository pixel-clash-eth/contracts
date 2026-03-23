import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import * as dotenv from "dotenv";

dotenv.config();

const PRIVATE_KEY = process.env.PRIVATE_KEY ?? "0x" + "0".repeat(64);
const RPC_URL = process.env.RPC_URL ?? "http://localhost:8545";

const config: HardhatUserConfig = {
  networks: {
    // Used by the deployment script: npx hardhat run scripts/deploy.ts --network live
    live: {
      url: RPC_URL,
      accounts: [PRIVATE_KEY],
    },
  },
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
};

export default config;
