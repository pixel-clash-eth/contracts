// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

// NOTE: the following fees are in USD cents.

uint256 constant ARENA_CREATION_FEE = 500;
uint256 constant PIXEL_FEE = 100;

interface PaymentToken is IERC20, IERC20Permit {}

contract PixelClash is
  Initializable,
  OwnableUpgradeable,
  PausableUpgradeable,
  ReentrancyGuardTransient,
  UUPSUpgradeable
{
  using SafeERC20 for PaymentToken;

  struct Arena {
    /// The user who created the arena.
    address owner;
    /// Name of team A.
    string teamAName;
    /// IPFS CID of team A's logo.
    bytes32 teamALogoCid;
    /// Name of team B.
    string teamBName;
    /// IPFS CID of team B's logo.
    bytes32 teamBLogoCid;
    /// Width of the pixel grid.
    uint gridWidth;
    /// Height of the pixel grid.
    uint gridHeight;
    /// Number of pixels owned by team A.
    uint teamA;
    /// Number of pixels owned by team B.
    uint teamB;
    /// Number of pixels owned by each player in team A.
    mapping(address => uint) countAByPlayer;
    /// Number of pixels owned by each player in team B.
    mapping(address => uint) countBByPlayer;
    /// Zero-based index of the winning pixel (must be less than gridWidth*gridHeight). This is
    /// initialized to -1 and is set to a valid index in the ChainLink VRF callback, when the
    /// winning pixel is drawn.
    int winner;
  }

  event CreateArena(address indexed owner, uint indexed id);

  PaymentToken public token;

  Arena[] public arenas;

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor() {
    _disableInitializers();
  }

  function initialize(address initialOwner, PaymentToken token_) public initializer {
    __Ownable_init(initialOwner);
    __Pausable_init();
    token = token_;
  }

  function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

  function pause() public onlyOwner {
    _pause();
  }

  function unpause() public onlyOwner {
    _unpause();
  }

  function createArenaWithPermit(
    string calldata teamAName,
    bytes32 teamALogoCid,
    string calldata teamBName,
    bytes32 teamBLogoCid,
    uint gridWidth,
    uint gridHeight,
    uint256 deadline,
    uint8 v,
    bytes32 r,
    bytes32 s
  ) public whenNotPaused nonReentrant {
    address owner = msg.sender;
    try token.permit(owner, address(this), ARENA_CREATION_FEE, deadline, v, r, s) {} catch {}
    token.safeTransferFrom(owner, address(this), ARENA_CREATION_FEE);
    uint id = arenas.length;
    arenas.push();
    Arena storage arena = arenas[id];
    arena.owner = owner;
    arena.teamAName = teamAName;
    arena.teamALogoCid = teamALogoCid;
    arena.teamBName = teamBName;
    arena.teamBLogoCid = teamBLogoCid;
    arena.gridWidth = gridWidth;
    arena.gridHeight = gridHeight;
    arena.winner = -1;
    emit CreateArena(owner, id);
  }

  function purchasePixelsWithPermit(
    uint arenaId,
    bool teamB,
    uint count,
    uint256 deadline,
    uint8 v,
    bytes32 r,
    bytes32 s
  ) public whenNotPaused nonReentrant {
    uint256 fee = PIXEL_FEE * count;
    try token.permit(msg.sender, address(this), fee, deadline, v, r, s) {} catch {}

    require(arenaId < arenas.length);
    Arena storage arena = arenas[arenaId];
    uint gridSize = arena.gridWidth * arena.gridHeight;
    uint availablePixels = gridSize - arena.teamA - arena.teamB;
    require(count <= availablePixels);
    address player = msg.sender;

    if (teamB) {
      arena.teamB += count;
      arena.countBByPlayer[player] += count;
    } else {
      arena.teamA += count;
      arena.countAByPlayer[player] += count;
    }

    token.safeTransferFrom(player, address(this), fee);

    if (arena.teamA + arena.teamB >= gridSize) {
      // TODO: draw!
    }
  }
}
