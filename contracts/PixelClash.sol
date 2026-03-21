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

// Arena creation fee in USD cents.
uint256 constant ARENA_CREATION_FEE = 2500;

// Fee for a single pixel in USD cents.
uint256 constant PIXEL_FEE = 100;

uint256 constant BLOCK_DURATION = 12 seconds;

// All arenas are unlocked after this time even if the grid wasn't fully filled.
uint256 constant ARENA_TIMEOUT = 7 days / BLOCK_DURATION;

// NOTE: all following prizes are expressed as a percentage of the total arena revenue.
uint256 constant WINNER_PRIZE = 45;
uint256 constant TEAM_PRIZE = 25;
uint256 constant SPONSOR_PRIZE = 10;
uint256 constant TOP_REFERRAL_PRIZE_1 = 6;
uint256 constant TOP_REFERRAL_PRIZE_2 = 3;
uint256 constant TOP_REFERRAL_PRIZE_3 = 1;
uint256 constant ARENA_OWNER_PRIZE = 5;

// Percentage of the arena revenue allocated to protocol fee.
uint256 constant PROTOCOL_FEE_PERCENT = 5;

interface PaymentToken is IERC20, IERC20Permit {}

struct Arena {
  /// The number of the block at which the arena was created.
  uint creationBlockNumber;
  /// The user who created the arena.
  address owner;
  /// Name of team A.
  string teamAName;
  /// Team A's logo emoji.
  string teamALogo;
  /// IPFS CID of team A's logo picture.
  bytes32 teamALogoCid;
  /// Team A color in RGB format. The least significant byte is Red, the second-least significant
  /// byte is Green, and the second-most significant byte is Blue. The most significant byte is
  /// unused and must be zero.
  uint32 teamAColor;
  /// Name of team B.
  string teamBName;
  /// Team B's logo emoji.
  string teamBLogo;
  /// IPFS CID of team B's logo picture.
  bytes32 teamBLogoCid;
  /// Team B color in RGB format. The least significant byte is Red, the second-least significant
  /// byte is Green, and the second-most significant byte is Blue. The most significant byte is
  /// unused and must be zero.
  uint32 teamBColor;
  /// Number of pixels in the grid.
  uint gridSize;
  /// Number of pixels owned by team A.
  uint teamA;
  /// Number of pixels owned by team B.
  uint teamB;
  /// Number of pixels owned by each player in team A.
  mapping(address => uint) countAByPlayer;
  /// Number of pixels owned by each player in team B.
  mapping(address => uint) countBByPlayer;
  /// The total revenue accumulated by the arena, including the initial creation fee. Post-drawing,
  /// players will start withdrawing their respective prizes from this balance.
  uint256 balance;
  /// Zero-based index of the winning pixel (must be less than gridSize). This is initialized to -1
  /// and is set to a valid index in the ChainLink VRF callback, when the winning pixel is drawn.
  int winner;
}

struct CreateArenaParams {
  string teamAName;
  string teamALogo;
  bytes32 teamALogoCid;
  uint32 teamAColor;
  string teamBName;
  string teamBLogo;
  bytes32 teamBLogoCid;
  uint32 teamBColor;
  uint gridSize;
}

library ArenaMethods {
  function getAvailablePixels(Arena storage arena) internal view returns (uint) {
    return arena.gridSize - arena.teamA - arena.teamB;
  }

  function isOpen(Arena storage arena) internal view returns (bool) {
    return
      arena.teamA + arena.teamB < arena.gridSize &&
      block.number < arena.creationBlockNumber + ARENA_TIMEOUT;
  }

  function isCompleted(Arena storage arena) internal view returns (bool) {
    return arena.winner >= 0;
  }
}

contract PixelClash is
  Initializable,
  OwnableUpgradeable,
  PausableUpgradeable,
  ReentrancyGuardTransient,
  UUPSUpgradeable
{
  using SafeERC20 for PaymentToken;
  using ArenaMethods for Arena;

  event CreateArena(address indexed owner, uint indexed id);

  event PurchasePixels(
    address indexed player,
    uint indexed arenaId,
    bool indexed teamB,
    uint count
  );

  /// All payments and prizes are this token.
  PaymentToken public token;

  /// List of arenas.
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
    CreateArenaParams calldata params,
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
    arena.creationBlockNumber = block.number;
    arena.owner = owner;
    arena.teamAName = params.teamAName;
    arena.teamALogo = params.teamALogo;
    arena.teamALogoCid = params.teamALogoCid;
    arena.teamAColor = params.teamAColor;
    arena.teamBName = params.teamBName;
    arena.teamBLogo = params.teamBLogo;
    arena.teamBLogoCid = params.teamBLogoCid;
    arena.teamBColor = params.teamBColor;
    arena.gridSize = params.gridSize;
    arena.balance = ARENA_CREATION_FEE;
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
    address player = msg.sender;
    require(arenaId < arenas.length);
    Arena storage arena = arenas[arenaId];
    require(arena.isOpen());

    uint availablePixels = arena.getAvailablePixels();
    if (count > availablePixels) {
      count = availablePixels;
    }

    uint256 fee = PIXEL_FEE * count;
    try token.permit(player, address(this), fee, deadline, v, r, s) {} catch {}

    if (teamB) {
      arena.teamB += count;
      arena.countBByPlayer[player] += count;
    } else {
      arena.teamA += count;
      arena.countAByPlayer[player] += count;
    }
    arena.balance += fee;

    token.safeTransferFrom(player, address(this), fee);

    emit PurchasePixels(player, arenaId, teamB, count);
  }

  function draw(uint arenaId) public whenNotPaused nonReentrant {
    require(arenaId < arenas.length);
    Arena storage arena = arenas[arenaId];
    require(!arena.isOpen() && !arena.isCompleted());
    // TODO: VRF request
  }
}
