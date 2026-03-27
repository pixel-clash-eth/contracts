// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {PixelClash} from "./PixelClash.sol";

contract PixelController is TimelockController {
  PixelClash public immutable pixelClash;

  constructor(
    PixelClash pixelClash_,
    address[] memory proposers,
    address[] memory executors,
    address admin
  ) TimelockController(/*minDelay=*/ 0, proposers, executors, admin) {
    pixelClash = pixelClash_;
  }

  /// Pauses the whole system (for emergency response).
  function pause() public onlyRole(DEFAULT_ADMIN_ROLE) {
    pixelClash.pause();
  }

  /// Unpauses the whole system.
  function unpause() public onlyRole(DEFAULT_ADMIN_ROLE) {
    pixelClash.unpause();
  }
}
