// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev Minimal mock for the ChainLink VRF V2+ wrapper. Only implements `link()`, which is called
/// during VRFConsumer construction.
contract MockVRFWrapper {
  function link() external pure returns (address) {
    return address(0);
  }
}
