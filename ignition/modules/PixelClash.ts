import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const JAN_1ST_2030 = 1893456000;
const ONE_GWEI: bigint = 1_000_000_000n;

const PixelClashModule = buildModule("PixelClashModule", (module) => {
  const unlockTime = module.getParameter("unlockTime", JAN_1ST_2030);
  const lockedAmount = module.getParameter("lockedAmount", ONE_GWEI);

  const lock = module.contract("Lock", [unlockTime], {
    value: lockedAmount,
  });

  return { lock };
});

export default PixelClashModule;
