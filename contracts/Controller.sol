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

  /// Swaps the revenue collected by the protocol so far and burns it.
  ///
  /// @param minPixelAmount The minimum amount of pixel tokens the revenue is swapped for. This
  ///   protects against sandwich attacks and other cases of high slippage.
  function burnRevenue(uint256 minPixelAmount) public onlyRole(DEFAULT_ADMIN_ROLE) {
    burnRevenue(minPixelAmount);
  }
}
