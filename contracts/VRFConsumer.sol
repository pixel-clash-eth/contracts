// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {VRFV2PlusWrapperConsumerBase} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFV2PlusWrapperConsumerBase.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";

// The ChainLink VRF will wait for this number of block confirmations before invoking our callback
// with the randomness.
uint16 constant VRF_REQUEST_CONFIRMATIONS = 10;

interface VRFClient {
  function fulfillRandomness(uint256 requestId, uint256 random) external;
}

contract VRFConsumer is VRFV2PlusWrapperConsumerBase {
  VRFClient public client;

  error PermissionDenied();

  constructor(address vrfWrapper) VRFV2PlusWrapperConsumerBase(vrfWrapper) {
    client = VRFClient(msg.sender);
  }

  function getRequestPrice(uint32 callbackGasLimit) public view returns (uint256) {
    return i_vrfV2PlusWrapper.calculateRequestPriceNative(callbackGasLimit, 1);
  }

  function requestRandomness(uint32 callbackGasLimit) public payable returns (uint256 requestId) {
    if (msg.sender != address(client)) {
      revert PermissionDenied();
    }
    (requestId, ) = requestRandomnessPayInNative(
      callbackGasLimit,
      VRF_REQUEST_CONFIRMATIONS,
      /*numWords=*/ 1,
      VRFV2PlusClient._argsToBytes(VRFV2PlusClient.ExtraArgsV1({nativePayment: true}))
    );
  }

  function fulfillRandomWords(uint256 requestId, uint256[] memory randomWords) internal override {
    client.fulfillRandomness(requestId, randomWords[0]);
  }
}
