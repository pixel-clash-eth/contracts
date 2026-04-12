// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {VRFCoordinatorV2_5Mock} from "@chainlink/contracts/src/v0.8/vrf/mocks/VRFCoordinatorV2_5Mock.sol";

contract MockVRFCoordinator is VRFCoordinatorV2_5Mock {
  constructor(
    uint96 baseFee,
    uint96 gasPrice,
    int256 weiPerUnitLink
  ) VRFCoordinatorV2_5Mock(baseFee, gasPrice, weiPerUnitLink) {}
}
