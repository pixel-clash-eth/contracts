import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";

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
};

export default config;
