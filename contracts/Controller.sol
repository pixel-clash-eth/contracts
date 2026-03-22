// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/governance/TimelockController.sol";

contract PixelController is TimelockController {
  constructor(
    address[] memory proposers,
    address[] memory executors,
    address admin
  ) TimelockController(/*minDelay=*/ 0, proposers, executors, admin) {}
}
