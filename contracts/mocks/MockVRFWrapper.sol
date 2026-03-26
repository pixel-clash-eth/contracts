// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {VRFV2PlusWrapper} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFV2PlusWrapper.sol";

contract MockVRFWrapper is VRFV2PlusWrapper {
  constructor(
    address link,
    address linkNativeFeed,
    address coordinator,
    uint256 subId
  ) VRFV2PlusWrapper(link, linkNativeFeed, coordinator, subId) {}
}
