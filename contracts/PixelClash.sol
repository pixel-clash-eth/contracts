// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@chainlink/contracts/src/v0.8/vrf/dev/interfaces/IVRFCoordinatorV2Plus.sol";
import "@chainlink/contracts/src/v0.8/vrf/dev/interfaces/IVRFMigratableConsumerV2Plus.sol";
import "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import "./Token.sol";

// Arena states.
uint256 constant ARENA_STATE_OPEN = 0;
uint256 constant ARENA_STATE_FULL = 1;
uint256 constant ARENA_STATE_TIMED_OUT = 2;
uint256 constant ARENA_STATE_DRAWING = 3;
uint256 constant ARENA_STATE_DRAWN = 4;

// Arena creation fee in USD cents. Currently $20.
uint256 constant ARENA_CREATION_FEE = 2000;

// Price of a single pixel in USD cents. $1 = 1 pixel.
uint256 constant PIXEL_FEE = 100;

// All arenas are unlocked after this time even if the grid wasn't fully filled.
uint256 constant ARENA_TIMEOUT = 7 days;

// The ChainLink VRF will wait for this number of block confirmations before invoking our callback
// with the randomness.
uint16 constant VRF_REQUEST_CONFIRMATIONS = 10;

// ChainLink VRF callback gas limit.
uint32 constant VRF_CALLBACK_GAS_LIMIT = 1_000_000;

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

interface CurrencyToken is IERC20, IERC20Metadata, IERC20Permit {}

/// A range of pixels in an arena.
///
/// `offset+length` must be less than or equal to the grid size of the arena.
struct Range {
  address owner;
  uint256 offset;
  uint256 length;
}

struct Arena {
  /// The time at which the arena was created.
  uint256 creationTimestamp;
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
  uint256 gridSize;
  /// Ranges of pixels acquired by team A. These are ordered chronologically, so the offset of the
  /// last range is always equal to the offset+length of the second-last.
  Range[] teamA;
  /// Ranges of pixels acquired by team B. These are ordered chronologically, so the offset of the
  /// last range is always equal to the offset+length of the second-last.
  Range[] teamB;
  /// The total revenue accumulated by the arena, including the initial creation fee. Post-drawing,
  /// players will start withdrawing their respective prizes from this balance.
  uint256 balance;
  /// VRF request ID, returned by the VRF coordinator invocation. The VRF callback checks the
  /// received request ID against this value and reverts if they differ.
  uint256 vrfRequestId;
  /// Zero-based index of the winning pixel (must be less than gridSize). This is initialized to -1
  /// and is set to a valid index in the ChainLink VRF callback, when the winning pixel is drawn.
  int256 winner;
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
  uint256 gridSize;
}

library ArenaMethods {
  function getTeamACount(Arena storage arena) internal view returns (uint256) {
    Range storage lastRange = arena.teamA[arena.teamA.length - 1];
    return lastRange.offset + lastRange.length;
  }

  function getTeamBCount(Arena storage arena) internal view returns (uint256) {
    Range storage lastRange = arena.teamB[arena.teamB.length - 1];
    return lastRange.offset + lastRange.length;
  }

  function getAvailablePixels(Arena storage arena) internal view returns (uint256) {
    uint256 teamACount = getTeamACount(arena);
    uint256 teamBCount = getTeamBCount(arena);
    assert(teamACount + teamBCount <= arena.gridSize);
    return arena.gridSize - getTeamACount(arena) - getTeamBCount(arena);
  }

  function isFull(Arena storage arena) private view returns (bool) {
    return getAvailablePixels(arena) > 0;
  }

  function isTimedOut(Arena storage arena) private view returns (bool) {
    return block.timestamp >= arena.creationTimestamp + ARENA_TIMEOUT;
  }

  function isDrawing(Arena storage arena) private view returns (bool) {
    return arena.vrfRequestId != 0;
  }

  function hasWinner(Arena storage arena) private view returns (bool) {
    return arena.winner >= 0;
  }

  function getState(Arena storage arena) internal view returns (uint256) {
    // TODO
  }

  function acquirePixels(
    Arena storage arena,
    address player,
    uint256 pixelFee,
    uint256 count,
    bool teamB
  ) internal {
    uint256 teamACount = getTeamACount(arena);
    uint256 teamBCount = getTeamBCount(arena);
    assert(teamACount + teamBCount + count <= arena.gridSize);
    if (teamB) {
      arena.teamB.push(Range({owner: player, offset: teamBCount, length: count}));
    } else {
      arena.teamA.push(Range({owner: player, offset: teamACount, length: count}));
    }
    arena.balance += pixelFee * count;
  }

  function getPixelOwner(
    Arena storage arena,
    uint256 index
  ) internal view returns (address owner, bool teamB) {
    uint256 teamACount = getTeamACount(arena);
    uint256 teamBCount = getTeamBCount(arena);
    assert(index < teamACount + teamBCount);
    uint256 index2 = arena.gridSize - 1 - index;
    if (index < teamACount) {
      uint256 i = 0;
      uint256 j = arena.teamA.length;
      while (i < j) {
        uint256 k = i + ((j - i) >> 1);
        Range storage range = arena.teamA[k];
        if (index < range.offset) {
          j = k;
        } else if (index >= range.offset + range.length) {
          i = k + 1;
        } else {
          return (range.owner, false);
        }
      }
    } else if (index2 < teamBCount) {
      uint256 i = 0;
      uint256 j = arena.teamB.length;
      while (i < j) {
        uint256 k = i + ((j - i) >> 1);
        Range storage range = arena.teamB[k];
        if (index2 < range.offset) {
          j = k;
        } else if (index2 >= range.offset + range.length) {
          i = k + 1;
        } else {
          return (range.owner, true);
        }
      }
    } else {
      // index is in the gap
      return (address(0), false);
    }
    assert(false);
  }
}

contract PixelClash is
  Initializable,
  OwnableUpgradeable,
  PausableUpgradeable,
  ReentrancyGuardTransient,
  UUPSUpgradeable,
  IVRFMigratableConsumerV2Plus
{
  using SafeERC20 for CurrencyToken;
  using ArenaMethods for Arena;

  event CreateArena(address indexed owner, uint256 indexed id);

  event PurchasePixels(
    address indexed player,
    uint256 indexed arenaId,
    bool indexed teamB,
    uint256 count
  );

  event VRFRequest(uint256 indexed arenaId, uint256 vrfRequestId);

  error InvalidArenaId(uint256 id);
  error InvalidState(uint256 arenaId, uint256 state);
  error OnlyCoordinatorCanFulfill(address have, address want);
  error OnlyOwnerOrCoordinator(address have, address owner, address coordinator);
  error ZeroAddress();

  /// All payments and prizes are in this token.
  CurrencyToken public currencyToken;

  /// All revenue is converted to this token and burned.
  PixelToken public pixelToken;

  /// @notice ChainLink VRF coordinator.
  IVRFCoordinatorV2Plus public vrfCoordinator;

  /// List of arenas.
  Arena[] public arenas;

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor() {
    _disableInitializers();
  }

  function initialize(
    address initialOwner,
    CurrencyToken currencyToken_,
    PixelToken pixelToken_
  ) public initializer {
    __Ownable_init(initialOwner);
    __Pausable_init();
    currencyToken = currencyToken_;
    pixelToken = pixelToken_;
  }

  function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

  modifier onlyOwnerOrCoordinator() {
    if (msg.sender != owner() && msg.sender != address(vrfCoordinator)) {
      revert OnlyOwnerOrCoordinator(msg.sender, owner(), address(vrfCoordinator));
    }
    _;
  }

  function setCoordinator(address _vrfCoordinator) external override onlyOwnerOrCoordinator {
    if (_vrfCoordinator == address(0)) {
      revert ZeroAddress();
    }
    vrfCoordinator = IVRFCoordinatorV2Plus(_vrfCoordinator);
    emit CoordinatorSet(_vrfCoordinator);
  }

  function pause() public onlyOwner {
    _pause();
  }

  function unpause() public onlyOwner {
    _unpause();
  }

  function arenaCreationFee() public view returns (uint256) {
    return (ARENA_CREATION_FEE * (10 ** currencyToken.decimals())) / 100;
  }

  function pixelFee() public view returns (uint256) {
    return (PIXEL_FEE * (10 ** currencyToken.decimals())) / 100;
  }

  function arenaTimeOut() public pure returns (uint256) {
    return ARENA_TIMEOUT;
  }

  function createArenaWithPermit(
    CreateArenaParams calldata params,
    uint256 deadline,
    uint8 v,
    bytes32 r,
    bytes32 s
  ) public whenNotPaused nonReentrant {
    address owner = msg.sender;
    uint256 fee = arenaCreationFee();
    try currencyToken.permit(owner, address(this), fee, deadline, v, r, s) {} catch {}
    currencyToken.safeTransferFrom(owner, address(this), fee);
    uint256 id = arenas.length;
    arenas.push();
    Arena storage arena = arenas[id];
    arena.creationTimestamp = block.timestamp;
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
    arena.balance = fee;
    arena.winner = -1;
    emit CreateArena(owner, id);
  }

  function purchasePixelsWithPermit(
    uint256 arenaId,
    bool teamB,
    uint256 count,
    uint256 deadline,
    uint8 v,
    bytes32 r,
    bytes32 s
  ) public whenNotPaused nonReentrant {
    address player = msg.sender;

    if (arenaId >= arenas.length) {
      revert InvalidArenaId(arenaId);
    }
    Arena storage arena = arenas[arenaId];
    if (arena.getState() != ARENA_STATE_OPEN) {
      revert InvalidState(arenaId, arena.getState());
    }

    uint256 availablePixels = arena.getAvailablePixels();
    if (count > availablePixels) {
      count = availablePixels;
    }

    uint256 fee = pixelFee() * count;
    try currencyToken.permit(player, address(this), fee, deadline, v, r, s) {} catch {}
    currencyToken.safeTransferFrom(player, address(this), fee);

    arena.acquirePixels(player, pixelFee(), count, teamB);
    emit PurchasePixels(player, arenaId, teamB, count);
  }

  function draw(uint256 arenaId, bytes32 vrfKeyHash) public whenNotPaused nonReentrant {
    if (arenaId >= arenas.length) {
      revert InvalidArenaId(arenaId);
    }
    Arena storage arena = arenas[arenaId];
    {
      uint256 state = arena.getState();
      if (state <= ARENA_STATE_OPEN || state >= ARENA_STATE_DRAWING) {
        revert InvalidState(arenaId, state);
      }
    }
    arena.vrfRequestId = vrfCoordinator.requestRandomWords(
      VRFV2PlusClient.RandomWordsRequest({
        keyHash: vrfKeyHash,
        subId: 0,
        requestConfirmations: VRF_REQUEST_CONFIRMATIONS,
        callbackGasLimit: VRF_CALLBACK_GAS_LIMIT,
        numWords: 1,
        extraArgs: VRFV2PlusClient._argsToBytes(VRFV2PlusClient.ExtraArgsV1({nativePayment: true}))
      })
    );
    emit VRFRequest(arenaId, arena.vrfRequestId);
  }
}
