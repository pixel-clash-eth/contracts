// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";

// The ChainLink VRF will wait for this number of block confirmations before invoking our callback
// with the randomness.
uint16 constant VRF_REQUEST_CONFIRMATIONS = 10;

interface VRFClient {
  function fulfillRandomness(uint256 requestId, uint256 random) external;
}

contract VRFConsumer is VRFConsumerBaseV2Plus {
  VRFClient public client;

  constructor(address vrfCoordinator) VRFConsumerBaseV2Plus(vrfCoordinator) {
    client = VRFClient(msg.sender);
  }

  function fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) internal override {
    client.fulfillRandomness(requestId, randomWords[0]);
  }

  function requestRandomness(
    bytes32 keyHash,
    uint32 callbackGasLimit
  ) public payable onlyOwner returns (uint256 requestId) {
    return
      s_vrfCoordinator.requestRandomWords(
        VRFV2PlusClient.RandomWordsRequest({
          keyHash: keyHash,
          subId: 0,
          requestConfirmations: VRF_REQUEST_CONFIRMATIONS,
          callbackGasLimit: callbackGasLimit,
          numWords: 1,
          extraArgs: VRFV2PlusClient._argsToBytes(
            VRFV2PlusClient.ExtraArgsV1({nativePayment: true})
          )
        })
      );
  }
}
