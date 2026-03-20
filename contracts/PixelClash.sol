// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

contract PixelClash {
  struct Battle {
    address creator;
    string teamAName;
    bytes32 teamALogoCid;
    string teamBName;
    bytes32 teamBLogoCid;
    uint gridWidth;
    uint gridHeight;
    uint teamA;
    uint teamB;
    mapping(address => uint) countAByPlayer;
    mapping(address => uint) countBByPlayer;
    int winner;
  }

  IERC20Permit public immutable token;

  Battle[] public battles;

  function createBattle(
    string calldata teamAName,
    bytes32 teamALogoCid,
    string calldata teamBName,
    bytes32 teamBLogoCid,
    uint gridWidth,
    uint gridHeight
  ) public {
    battles.push();
    Battle storage battle = battles[battles.length - 1];
    battle.creator = msg.sender;
    battle.teamAName = teamAName;
    battle.teamALogoCid = teamALogoCid;
    battle.teamBName = teamBName;
    battle.teamBLogoCid = teamBLogoCid;
    battle.gridWidth = gridWidth;
    battle.gridHeight = gridHeight;
    battle.winner = -1;
  }

  function purchasePixelsWithPermit(
    uint battleId,
    bool teamB,
    uint count,
    uint256 deadline,
    uint8 v,
    bytes32 r,
    bytes32 s
  ) public {
    require(battleId < battles.length);
    Battle storage battle = battles[battleId];
    uint gridSize = battle.gridWidth * battle.gridHeight;
    uint availablePixels = gridSize - battle.teamA - battle.teamB;
    require(count <= availablePixels);
    address player = msg.sender;

    if (teamB) {
      battle.teamB += count;
      battle.countBByPlayer[player] += count;
    } else {
      battle.teamA += count;
      battle.countAByPlayer[player] += count;
    }

    if (battle.teamA + battle.teamB >= gridSize) {
      // TODO: draw!
    }
  }
}
