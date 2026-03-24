// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {PixelToken} from "./Token.sol";
import {VRFClient, VRFConsumer} from "./VRFConsumer.sol";

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

// ChainLink VRF callback gas limit.
uint32 constant VRF_CALLBACK_GAS_LIMIT = 1_000_000;

// NOTE: all following prizes are expressed as a percentage of the total arena revenue. Prizes add
// up to 95% of the revenue, with the remaining 5% being the protocol fee.
uint256 constant WINNER_PRIZE = 45;
uint256 constant TEAM_PRIZE = 25;
uint256 constant SPONSOR_PRIZE = 10;
uint256 constant TOP_REFERRAL_PRIZE_1 = 6;
uint256 constant TOP_REFERRAL_PRIZE_2 = 3;
uint256 constant TOP_REFERRAL_PRIZE_3 = 1;
uint256 constant ARENA_OWNER_PRIZE = 5;

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
  /// The number of pixels acquired by each player on team A. Must be consistent with the `teamA`
  /// ranges.
  mapping(address => uint256) teamAShares;
  /// The number of pixels acquired by each player on team B. Must be consistent with the `teamB`
  /// ranges.
  mapping(address => uint256) teamBShares;
  /// The total revenue accumulated by the arena, including the initial creation fee.
  uint256 revenue;
  /// The current balance of the arena, equal to `revenue` minus anything that has been withdrawn.
  uint256 balance;
  /// VRF request ID, returned by the VRF coordinator invocation. The VRF callback checks the
  /// received request ID against this value and reverts if they differ.
  uint256 vrfRequestId;
  /// Zero-based index of the winning pixel (must be less than gridSize). This is initialized to -1
  /// and is set to a valid index in the ChainLink VRF callback, when the winning pixel is drawn.
  int256 winner;
  /// Prize amounts withdrawn by each one involved. Note that the sum of all values stored here must
  /// equal `revenue - balance`.
  mapping(address => uint256) withdrawals;
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
  /// Returns the number of pixels acquired by team A.
  function getTeamACount(Arena storage arena) public view returns (uint256) {
    Range storage lastRange = arena.teamA[arena.teamA.length - 1];
    return lastRange.offset + lastRange.length;
  }

  /// Returns the number of pixels acquired by team B.
  function getTeamBCount(Arena storage arena) public view returns (uint256) {
    Range storage lastRange = arena.teamB[arena.teamB.length - 1];
    return lastRange.offset + lastRange.length;
  }

  /// Returns the number of pixels still available for purchase (the size of the "gap").
  function getAvailablePixels(Arena storage arena) public view returns (uint256) {
    uint256 teamACount = getTeamACount(arena);
    uint256 teamBCount = getTeamBCount(arena);
    assert(teamACount + teamBCount <= arena.gridSize);
    return arena.gridSize - teamACount - teamBCount;
  }

  function isFull(Arena storage arena) private view returns (bool) {
    return getAvailablePixels(arena) == 0;
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

  /// Returns the current state of the arena. See the `ARENA_STATE_*` constants at the top.
  function getState(Arena storage arena) public view returns (uint256) {
    if (isTimedOut(arena)) {
      if (hasWinner(arena)) {
        return ARENA_STATE_DRAWN;
      } else if (isDrawing(arena)) {
        return ARENA_STATE_DRAWING;
      } else {
        return ARENA_STATE_TIMED_OUT;
      }
    } else if (isFull(arena)) {
      if (hasWinner(arena)) {
        return ARENA_STATE_DRAWN;
      } else if (isDrawing(arena)) {
        return ARENA_STATE_DRAWING;
      } else {
        return ARENA_STATE_FULL;
      }
    } else {
      return ARENA_STATE_OPEN;
    }
  }

  /// Acquires the given number of pixels.
  ///
  /// NOTE: `count` pixels MUST be available in the arena, otherwise this function will assert.
  ///
  /// @param arena The `Arena` instance.
  /// @param player Address of the player acquiring the pixels.
  /// @param pixelFee The cost of each pixel.
  /// @param count The number of pixels to acquire.
  /// @param teamB Whether tha player is playing in team A or B. If true, the pixels will be
  ///   acquired by team B, otherwise they'll be acquire by team A.
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
      arena.teamBShares[player] += count;
    } else {
      arena.teamA.push(Range({owner: player, offset: teamACount, length: count}));
      arena.teamAShares[player] += count;
    }
    uint256 fee = pixelFee * count;
    arena.revenue += fee;
    arena.balance += fee;
  }

  /// Returns the owner of a given pixel.
  ///
  /// @param arena The `Arena` instance.
  /// @param index The zero-based index of the pixel to query. Must be strictly less than
  ///   `arena.gridSize`.
  /// @return owner The owner of the pixel, or the zero address if the pixel is in the gap.
  /// @return teamB Whether the pixel has been acquired by team A or B. Ignore this value if the
  ///   pixel is in the gap.
  function getPixelOwner(
    Arena storage arena,
    uint256 index
  ) public view returns (address owner, bool teamB) {
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

  function draw(
    Arena storage arena,
    uint256 random
  ) internal returns (uint256 winner, uint256 revenue) {
    assert(getState(arena) == ARENA_STATE_DRAWING);
    uint256 teamACount = getTeamACount(arena);
    uint256 teamBCount = getTeamBCount(arena);
    uint256 acquiredPixels = teamACount + teamBCount;
    uint256 gapSize = arena.gridSize - acquiredPixels;
    winner = random % acquiredPixels;
    if (winner >= teamACount) {
      winner += gapSize;
    }
    arena.winner = int256(winner);
    arena.vrfRequestId = 0;
    revenue = arena.revenue - getTotalPrizes(arena);
    arena.balance -= revenue;
  }

  /// Indicates whether team A won.
  function teamAWins(Arena storage arena) public view returns (bool) {
    assert(getState(arena) >= ARENA_STATE_DRAWN);
    uint256 teamACount = getTeamACount(arena);
    return uint256(arena.winner) < teamACount;
  }

  /// Indicates whether team B won.
  function teamBWins(Arena storage arena) public view returns (bool) {
    assert(getState(arena) >= ARENA_STATE_DRAWN);
    uint256 teamBCount = getTeamBCount(arena);
    return uint256(arena.winner) >= arena.gridSize - teamBCount;
  }

  /// Returns the prize for the winner (the player owning the winning pixel).
  function getWinnerPrize(Arena storage arena) public view returns (uint256) {
    assert(getState(arena) >= ARENA_STATE_TIMED_OUT);
    return (arena.revenue * WINNER_PRIZE) / 100;
  }

  /// Returns the prize for the team owning the winning pixel.
  function getTeamPrize(Arena storage arena) public view returns (uint256) {
    assert(getState(arena) >= ARENA_STATE_TIMED_OUT);
    return (arena.revenue * TEAM_PRIZE) / 100;
  }

  /// Returns the team prize for a given player based on how many pixels they acquired in that team.
  function getTeamPrizeFor(
    Arena storage arena,
    address player,
    bool teamB
  ) public view returns (uint256) {
    assert(getState(arena) >= ARENA_STATE_TIMED_OUT);
    uint256 teamPixels = teamB ? getTeamBCount(arena) : getTeamACount(arena);
    uint256 playerPixels = teamB ? arena.teamBShares[player] : arena.teamAShares[player];
    return (arena.revenue * TEAM_PRIZE * playerPixels) / (100 * teamPixels);
  }

  /// Returns the prize for the referrer of the winner, or zero if the winner had no referrer.
  function getSponsorPrize(Arena storage arena) public view returns (uint256) {
    assert(getState(arena) >= ARENA_STATE_DRAWN);
    // TODO: implement referrals.
    return 0;
  }

  function getTopReferralPrize1(Arena storage arena) public view returns (uint256) {
    assert(getState(arena) >= ARENA_STATE_TIMED_OUT);
    return (arena.revenue * TOP_REFERRAL_PRIZE_1) / 100;
  }

  function getTopReferralPrize2(Arena storage arena) public view returns (uint256) {
    assert(getState(arena) >= ARENA_STATE_TIMED_OUT);
    return (arena.revenue * TOP_REFERRAL_PRIZE_2) / 100;
  }

  function getTopReferralPrize3(Arena storage arena) public view returns (uint256) {
    assert(getState(arena) >= ARENA_STATE_TIMED_OUT);
    return (arena.revenue * TOP_REFERRAL_PRIZE_3) / 100;
  }

  function getTopReferralPrize(Arena storage arena) public view returns (uint256) {
    return getTopReferralPrize1(arena) + getTopReferralPrize2(arena) + getTopReferralPrize3(arena);
  }

  function getArenaOwnerPrize(Arena storage arena) public view returns (uint256) {
    assert(getState(arena) >= ARENA_STATE_TIMED_OUT);
    return (arena.revenue * ARENA_OWNER_PRIZE) / 100;
  }

  /// Returns the sum of all prizes, which is 95% of the arena revenue.
  function getTotalPrizes(Arena storage arena) public view returns (uint256) {
    assert(getState(arena) >= ARENA_STATE_DRAWN);
    return
      getWinnerPrize(arena) +
      getTeamPrize(arena) +
      getSponsorPrize(arena) +
      getTopReferralPrize(arena) +
      getArenaOwnerPrize(arena);
  }

  /// Returns the total prizes won by a player in this arena.
  function getTotalPrizeFor(Arena storage arena, address player) public view returns (uint256) {
    assert(getState(arena) >= ARENA_STATE_DRAWN);
    (address winner, bool teamB) = getPixelOwner(arena, uint256(arena.winner));
    uint256 winnerPrize = (player != winner) ? 0 : getWinnerPrize(arena);
    uint256 teamPrize = (teamB != teamBWins(arena)) ? 0 : getTeamPrizeFor(arena, player, teamB);
    uint256 ownerPrize = (player != arena.owner) ? 0 : getArenaOwnerPrize(arena);
    return winnerPrize + teamPrize + ownerPrize;
  }
}

contract PixelClash is
  Initializable,
  OwnableUpgradeable,
  PausableUpgradeable,
  ReentrancyGuardTransient,
  UUPSUpgradeable,
  VRFClient,
  IUnlockCallback
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
  event ArenaClosure(uint256 indexed arenaId, uint256 vrfRequestId, uint256 winner);

  event WithdrawPrize(uint256 indexed arenaId, address indexed player, uint256 prize);

  error AlreadyWithdrawn(uint256 arenaId, address player);
  error GridTooSmall(uint256 gridSize);
  error InvalidArenaId(uint256 id);
  error InvalidArgument();
  error InvalidState(uint256 arenaId, uint256 state);
  error NoPrize(uint256 arenaId, address player);
  error OnlyCoordinatorCanFulfill(address have, address want);
  error OnlyOwnerOrCoordinator(address have, address owner, address coordinator);
  error PermissionDenied();
  error ZeroAddress();

  /// All payments and prizes are in this token.
  CurrencyToken public currencyToken;

  /// All revenue is converted to this token and burned.
  PixelToken public pixelToken;

  /// ChainLink VRF consumer.
  VRFConsumer public vrfConsumer;

  /// Uniswap V4 pool manager used to swap CurrencyToken for PixelToken.
  IPoolManager public poolManager;

  /// Uniswap V4 pool key identifying the CurrencyToken / PixelToken pool.
  PoolKey public swapPoolKey;

  /// List of arenas.
  Arena[] public arenas;

  /// Arena IDs indexed by VRF request ID. Used to retrieve the correct arena in the VRF callback.
  mapping(uint256 => uint256) public arenaIdsByVrfRequestId;

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor() {
    _disableInitializers();
  }

  function initialize(
    address initialOwner,
    CurrencyToken currencyToken_,
    PixelToken pixelToken_,
    address vrfCoordinator,
    IPoolManager poolManager_,
    PoolKey memory swapPoolKey_
  ) public initializer {
    __Ownable_init(initialOwner);
    __Pausable_init();
    currencyToken = currencyToken_;
    pixelToken = pixelToken_;
    vrfConsumer = new VRFConsumer(vrfCoordinator);
    poolManager = poolManager_;
    swapPoolKey = swapPoolKey_;
  }

  function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

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

  function getArena(uint256 id) private view returns (Arena storage arena) {
    if (id == 0 || id >= arenas.length) {
      revert InvalidArenaId(id);
    }
    arena = arenas[id];
  }

  /// Creates a new pixel arena.
  ///
  /// Payment of a fee equal to `ARENA_CREATION_FEE` is required. The payment is carried out via an
  /// ERC-2612 signature.
  ///
  /// @param params The arena creation parameters.
  /// @param deadline The deadline of the ERC-2612 signature.
  /// @param v The `v` parameter of the ERC-2612 signature.
  /// @param r The `r` parameter of the ERC-2612 signature.
  /// @param s The `s` parameter of the ERC-2612 signature.
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

    // Skip arena #0 because ID 0 is considered invalid.
    arenas.push();

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
    arena.revenue = fee;
    arena.balance = fee;
    arena.winner = -1;
    uint256 numPixelsPerTeam = fee / pixelFee() / 2;
    if (numPixelsPerTeam * 2 >= arena.gridSize) {
      revert GridTooSmall(arena.gridSize);
    }
    arena.teamA.push(Range({owner: owner, offset: 0, length: numPixelsPerTeam}));
    arena.teamAShares[owner] += numPixelsPerTeam;
    arena.teamB.push(Range({owner: owner, offset: 0, length: numPixelsPerTeam}));
    arena.teamBShares[owner] += numPixelsPerTeam;
    emit CreateArena(owner, id);
    emit PurchasePixels(owner, id, false, numPixelsPerTeam);
    emit PurchasePixels(owner, id, true, numPixelsPerTeam);
  }

  /// Acquires one or more pixels in an arena.
  ///
  /// Payment of a fee equal to `PIXEL_FEE` multiplied by the number of pixels. The payment is
  /// carried out via an ERC-2612 signature.
  ///
  /// Note that the arena must be in state `ARENA_STATE_OPEN`, otherwise this method will revert.
  ///
  /// If the number of available pixels is less than `count`, `count` will be automatically set to
  /// the number of available pixels and the fee to pay will get adjusted accordingly. This avoids
  /// that all transactions fail when many players try to purchase the last remaining pixels in an
  /// arena roughly at the same time (ie. within the same block). One of the players will definitely
  /// manage to acquire the remaining pixels and close the arena.
  ///
  /// @param arenaId The arena ID.
  /// @param teamB If true the pixels will be acquired by team B, otherwise by team A.
  /// @param count The number of pixels to acquire. Must be > 0.
  /// @param deadline The deadline of the ERC-2612 signature.
  /// @param v The `v` parameter of the ERC-2612 signature.
  /// @param r The `r` parameter of the ERC-2612 signature.
  /// @param s The `s` parameter of the ERC-2612 signature.
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

    Arena storage arena = getArena(arenaId);
    if (arena.getState() != ARENA_STATE_OPEN) {
      revert InvalidState(arenaId, arena.getState());
    }

    if (count == 0) {
      revert InvalidArgument();
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

  /// Returns the price of a draw in ETH.
  function getDrawPrice() public view returns (uint256) {
    return vrfConsumer.getRequestPrice(VRF_CALLBACK_GAS_LIMIT);
  }

  /// Triggers the final drawing for an arena.
  ///
  /// This function call must be funded with the ETH value specified by `getDrawPrice`.
  //
  /// The transaction will fail if the arena is not in the `ARENA_STATE_FULL` or
  /// `ARENA_STATE_TIMED_OUT` state.
  ///
  /// @param arenaId The ID of the arena.
  function draw(uint256 arenaId) public payable whenNotPaused nonReentrant {
    Arena storage arena = getArena(arenaId);
    {
      uint256 state = arena.getState();
      if (state <= ARENA_STATE_OPEN || state >= ARENA_STATE_DRAWING) {
        revert InvalidState(arenaId, state);
      }
    }
    arena.vrfRequestId = vrfConsumer.requestRandomness{value: msg.value}(VRF_CALLBACK_GAS_LIMIT);
    arenaIdsByVrfRequestId[arena.vrfRequestId] = arenaId;
    emit VRFRequest(arenaId, arena.vrfRequestId);
  }

  /// VRF callback.
  ///
  /// @param requestId The VRF request ID.
  /// @param random The random word returned by the ChainLink VRF.
  function fulfillRandomness(uint256 requestId, uint256 random) external nonReentrant {
    if (msg.sender != address(vrfConsumer)) {
      revert PermissionDenied();
    }

    uint256 arenaId = arenaIdsByVrfRequestId[requestId];
    Arena storage arena = getArena(arenaId);
    if (arena.getState() != ARENA_STATE_DRAWING) {
      revert InvalidState(arenaId, arena.getState());
    }
    assert(arena.vrfRequestId == requestId);

    (uint256 winner, uint256 revenue) = arena.draw(random);
    uint256 pixelAmount = abi.decode(poolManager.unlock(abi.encode(revenue)), (uint256));
    pixelToken.burn(pixelAmount);

    emit ArenaClosure(arenaId, requestId, winner);
  }

  /// @inheritdoc IUnlockCallback
  function unlockCallback(bytes calldata data) external returns (bytes memory) {
    if (msg.sender != address(poolManager)) {
      revert PermissionDenied();
    }

    uint256 revenue = abi.decode(data, (uint256));
    bool zeroForOne = Currency.unwrap(swapPoolKey.currency0) == address(currencyToken);

    BalanceDelta delta = poolManager.swap(
      swapPoolKey,
      SwapParams({
        zeroForOne: zeroForOne,
        amountSpecified: -int256(revenue),
        sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
      }),
      ""
    );

    // Settle: sync balance checkpoint, transfer tokens in, then acknowledge.
    Currency currencyIn = zeroForOne ? swapPoolKey.currency0 : swapPoolKey.currency1;
    poolManager.sync(currencyIn);
    currencyToken.safeTransfer(address(poolManager), revenue);
    poolManager.settle();

    // Take the output tokens from the pool manager.
    uint256 pixelAmount =
      zeroForOne ? uint256(uint128(delta.amount1())) : uint256(uint128(delta.amount0()));
    Currency currencyOut = zeroForOne ? swapPoolKey.currency1 : swapPoolKey.currency0;
    poolManager.take(currencyOut, address(this), pixelAmount);

    return abi.encode(pixelAmount);
  }

  /// Returns the total prizes won by a player in the given arena.
  ///
  /// Reverts if the arena hasn't received its draw yet.
  function getPrizeFor(uint256 arenaId, address player) public view returns (uint256) {
    Arena storage arena = getArena(arenaId);
    uint256 state = arena.getState();
    if (state < ARENA_STATE_DRAWN) {
      revert InvalidState(arenaId, state);
    }
    return arena.getTotalPrizeFor(player);
  }

  /// Withdraws the prize for the caller from the specified arena, if any.
  ///
  /// The amount returned by `getPrize` for the same arena is transferred to the caller if it hasn't
  /// been transferred before. If the amount is zero (ie. the player didn't win anything from that
  /// arena) the transaction is reverted.
  function withdrawPrize(uint256 arenaId) public whenNotPaused nonReentrant {
    address player = msg.sender;
    Arena storage arena = getArena(arenaId);
    {
      uint256 state = arena.getState();
      if (state < ARENA_STATE_DRAWN) {
        revert InvalidState(arenaId, state);
      }
    }
    uint256 prize = arena.getTotalPrizeFor(player);
    if (prize == 0) {
      revert NoPrize(arenaId, player);
    }
    if (arena.withdrawals[player] >= prize) {
      revert AlreadyWithdrawn(arenaId, player);
    }
    uint256 amount = prize - arena.withdrawals[player];
    arena.balance -= amount;
    arena.withdrawals[player] += amount;
    currencyToken.safeTransfer(player, amount);
    emit WithdrawPrize(arenaId, player, amount);
  }
}
