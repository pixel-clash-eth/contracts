// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {
  Arena,
  ArenaData,
  ArenaMethods,
  CreateArenaParams,
  Prizes,
  Range,
  ARENA_STATE_OPEN,
  ARENA_STATE_FULL,
  ARENA_STATE_DRAWING,
  ARENA_STATE_DRAWN
} from "./Arena.sol";

import {ReferralRevenue} from "./Heap.sol";
import {VRFClient, VRFConsumer} from "./VRFConsumer.sol";

// Maximum arena grid size.
uint256 constant MAX_GRID_SIZE = 1e19;

// Arena creation fee in USD cents. Currently $20.
uint256 constant ARENA_CREATION_FEE = 2000;

// ChainLink VRF callback gas limit.
uint32 constant VRF_CALLBACK_GAS_LIMIT = 1_000_000;

interface ICurrencyToken is IERC20, IERC20Metadata, IERC20Permit {}

contract PixelClash is
  Initializable,
  OwnableUpgradeable,
  PausableUpgradeable,
  ReentrancyGuardTransient,
  UUPSUpgradeable,
  VRFClient,
  IUnlockCallback
{
  using Address for address payable;
  using SafeERC20 for ICurrencyToken;
  using ArenaMethods for Arena;

  /// @notice New arena created.
  /// @param owner The owner of the arena.
  /// @param id The arena ID.
  event CreateArena(address indexed owner, uint256 indexed id);

  /// @notice Pixels purchased by a player for one of the teams in an arena.
  /// @param player The player who made the purchase.
  /// @param arenaId The arena ID.
  /// @param teamB True if the pixels were acquired for team B, false for team A.
  /// @param requested The number of pixels the player requested to purchase.
  /// @param acquired The number of pixels actually acquired (may be less than `requested` if the
  ///   arena filled up during the transaction).
  event PurchasePixels(
    address indexed player,
    uint256 indexed arenaId,
    bool indexed teamB,
    uint256 requested,
    uint256 acquired
  );

  /// @notice A Chainlink VRF randomness request was submitted for an arena draw.
  /// @param arenaId The arena ID.
  /// @param vrfRequestId The Chainlink VRF request ID.
  event VRFRequest(uint256 indexed arenaId, uint256 vrfRequestId);

  /// @notice An arena draw has been completed and a winner determined.
  /// @param arenaId The arena ID.
  /// @param vrfRequestId The Chainlink VRF request ID that produced the random word.
  /// @param winner The zero-based index of the winning pixel.
  event ArenaClosure(uint256 indexed arenaId, uint256 vrfRequestId, uint256 winner);

  /// @notice A player withdrew their prize from a concluded arena.
  /// @param arenaId The arena ID.
  /// @param player The player who withdrew the prize.
  /// @param prize The amount of currency tokens transferred to the player.
  event WithdrawPrize(uint256 indexed arenaId, address indexed player, uint256 prize);

  error AlreadyWithdrawn(uint256 arenaId, address player);
  error GridTooBig(uint256 gridSize, uint256 max);
  error GridTooSmall(uint256 gridSize);
  error InvalidPaymentAmount(uint256 got, uint256 want);
  error InvalidArenaId(uint256 id);
  error InvalidArgument();
  error InvalidState(uint256 arenaId, uint256 got, uint256 want);
  error NoPrize(uint256 arenaId, address player);
  error PermissionDenied();
  error SelfReferralForbidden();
  error SlippageTooHigh(uint256 got, uint256 want);

  /// @notice All payments and prizes are in this token.
  ICurrencyToken public currencyToken;

  /// @notice All revenue is converted to this token and burned (see `burnRevenue`).
  ERC20Burnable public pixelToken;

  /// @notice ChainLink VRF consumer.
  VRFConsumer public vrfConsumer;

  /// @notice Uniswap V4 pool manager used to swap currencyToken for pixelToken.
  IPoolManager public poolManager;

  /// @notice Uniswap V4 pool key identifying the currencyToken / pixelToken pool.
  PoolKey public swapPoolKey;

  /// @notice List of arenas.
  Arena[] private arenas;

  /// @notice Protocol revenue in USDC.
  uint256 public protocolRevenue;

  /// @notice Arena IDs indexed by VRF request ID. Used to retrieve the correct arena in the VRF
  ///   callback.
  mapping(uint256 => uint256) public arenaIdsByVrfRequestId;

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor() {
    _disableInitializers();
  }

  function initialize(
    address initialOwner,
    ICurrencyToken currencyToken_,
    ERC20Burnable pixelToken_,
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

    // Skip arena #0 because ID 0 is conventionally invalid.
    arenas.push();
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

  function getArenaFromStorage(uint256 id) private view returns (Arena storage arena) {
    if (id == 0 || id >= arenas.length) {
      revert InvalidArenaId(id);
    }
    arena = arenas[id];
  }

  function getArenaAndCheckState(
    uint256 arenaId,
    uint256 expectedState
  ) private view returns (Arena storage arena) {
    arena = getArenaFromStorage(arenaId);
    uint256 state = arena.getState();
    if (state != expectedState) {
      revert InvalidState(arenaId, state, expectedState);
    }
  }

  /// @notice Retrieves the state of the given arena.
  /// @param arenaId The arena ID.
  /// @return An `ArenaData` containing most of the state of the arena.
  function getArenaData(uint256 arenaId) public view returns (ArenaData memory) {
    Arena storage arena = getArenaFromStorage(arenaId);
    return
      ArenaData({
        creationTimestamp: arena.creationTimestamp,
        owner: arena.owner,
        teamAName: arena.teamAName,
        teamALogo: arena.teamALogo,
        teamALogoCid: arena.teamALogoCid,
        teamAColor: arena.teamAColor,
        teamBName: arena.teamBName,
        teamBLogo: arena.teamBLogo,
        teamBLogoCid: arena.teamBLogoCid,
        teamBColor: arena.teamBColor,
        gridSize: arena.gridSize,
        pixelFee: arena.pixelFee,
        maxDuration: arena.maxDuration,
        state: arena.getState(),
        teamACount: arena.getTeamACount(),
        teamBCount: arena.getTeamBCount(),
        revenue: arena.revenue,
        balance: arena.balance,
        vrfRequestId: arena.vrfRequestId,
        winner: arena.winner
      });
  }

  /// @notice Returns the owner of a given pixel.
  /// @param arenaId The arena ID.
  /// @param index The zero-based index of the pixel to query. Must be strictly less than the
  ///   `gridSize` of the arena.
  /// @return player The owner of the pixel, or the zero address if the pixel is in the gap.
  /// @return teamB Whether the pixel has been acquired by team A or B. Ignore this value if the
  ///   pixel is in the gap.
  /// @return referrer The referrer through which the pixel was purchased, or zero if the pixel
  ///   wasn't purchased through a referral.
  function getPixelOwner(
    uint256 arenaId,
    uint256 index
  ) public view returns (address player, bool teamB, address referrer) {
    Arena storage arena = getArenaFromStorage(arenaId);
    return arena.getPixelOwner(index);
  }

  /// @notice Returns the referral revenue generated by a specific referrer.
  /// @dev Returns zero if the specified address hasn't referred any purchase.
  /// @param arenaId The arena ID.
  /// @param referrer The queried referrer address.
  /// @return The generated revenue.
  function getReferralRevenueFrom(uint256 arenaId, address referrer) public view returns (uint256) {
    Arena storage arena = getArenaFromStorage(arenaId);
    return arena.getReferralRevenueFrom(referrer);
  }

  /// @notice Returns the top 3 referrers (by generated revenue) for the specified arena.
  /// @dev The returned elements are sorted in descending order: the first one is the top referrer,
  ///   the one that generated the most revenue.
  /// @dev Note that less than 3 elements may be returned if an arena has had less than 3 referrers
  ///   (not referrals!) so far. For this function to return at least 3 elements, at least 3
  ///   different addresses must have successfully referred other players.
  /// @param arenaId The arena ID.
  /// @return referrers The top 3 referrers.
  function getTopReferrers(
    uint256 arenaId
  ) public view returns (ReferralRevenue[] memory referrers) {
    Arena storage arena = getArenaFromStorage(arenaId);
    return arena.getTop3Referrers();
  }

  /// @notice Creates a new pixel arena.
  /// @dev Payment of a fee equal to `ARENA_CREATION_FEE` is required. The payment is carried out
  ///   via an ERC-2612 signature.
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
    if (params.gridSize > MAX_GRID_SIZE) {
      revert GridTooBig(params.gridSize, MAX_GRID_SIZE);
    }
    address owner = msg.sender;
    uint256 fee = arenaCreationFee();
    try currencyToken.permit(owner, address(this), fee, deadline, v, r, s) {} catch {}
    currencyToken.safeTransferFrom(owner, address(this), fee);

    if (
      (bytes(params.teamAName).length == 0) ||
      (bytes(params.teamALogo).length == 0) ||
      (bytes(params.teamBName).length == 0) ||
      (bytes(params.teamBLogo).length == 0) ||
      (params.gridSize == 0) ||
      ((params.gridSize % 2) != 0) ||
      (params.pixelFee == 0) ||
      (params.maxDuration == 0)
    ) {
      revert InvalidArgument();
    }

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
    arena.pixelFee = params.pixelFee;
    arena.maxDuration = params.maxDuration;
    arena.winner = -1;
    uint256 numPixelsPerTeam = fee / arena.pixelFee / 2;
    if (numPixelsPerTeam * 2 >= arena.gridSize) {
      revert GridTooSmall(arena.gridSize);
    }
    arena.teamA.push(
      Range({owner: owner, offset: 0, length: numPixelsPerTeam, referrer: address(0)})
    );
    arena.teamAShares[owner] += numPixelsPerTeam;
    arena.teamB.push(
      Range({owner: owner, offset: 0, length: numPixelsPerTeam, referrer: address(0)})
    );
    arena.teamBShares[owner] += numPixelsPerTeam;

    protocolRevenue += fee;

    emit CreateArena(owner, id);
    emit PurchasePixels(owner, id, false, numPixelsPerTeam, numPixelsPerTeam);
    emit PurchasePixels(owner, id, true, numPixelsPerTeam, numPixelsPerTeam);
  }

  /// @notice Acquires one or more pixels in an arena.
  /// @dev Payment of a fee equal to `PIXEL_FEE` multiplied by the number of pixels. The payment is
  ///   carried out via an ERC-2612 signature.
  /// @dev Note that the arena must be in state `ARENA_STATE_OPEN`, otherwise this method will
  ///   revert.
  /// @dev If the number of available pixels is less than `count`, `count` will be automatically set
  ///   to the number of available pixels and the fee to pay will get adjusted accordingly. This
  ///   avoids that all transactions fail when many players try to purchase the last remaining
  ///   pixels in an arena roughly at the same time (ie. within the same block). One of the players
  ///   will definitely manage to acquire the remaining pixels and close the arena.
  /// @param arenaId The arena ID.
  /// @param teamB If true the pixels will be acquired by team B, otherwise by team A.
  /// @param count The number of pixels to acquire. Must be > 0.
  /// @param referrer The referrer's address, or the zero address if this purchase wasn't referred.
  /// @param deadline The deadline of the ERC-2612 signature.
  /// @param v The `v` parameter of the ERC-2612 signature.
  /// @param r The `r` parameter of the ERC-2612 signature.
  /// @param s The `s` parameter of the ERC-2612 signature.
  function purchasePixelsWithPermit(
    uint256 arenaId,
    bool teamB,
    uint256 count,
    address referrer,
    uint256 deadline,
    uint8 v,
    bytes32 r,
    bytes32 s
  ) public whenNotPaused nonReentrant {
    address player = msg.sender;
    if (player == referrer) {
      revert SelfReferralForbidden();
    }

    Arena storage arena = getArenaAndCheckState(arenaId, ARENA_STATE_OPEN);

    if (count == 0) {
      revert InvalidArgument();
    }

    uint256 fee = arena.pixelFee * count;
    try currencyToken.permit(player, address(this), fee, deadline, v, r, s) {} catch {}
    currencyToken.safeTransferFrom(player, address(this), fee);

    uint256 acquired = arena.acquirePixels(player, count, teamB, referrer);
    if (acquired < count) {
      uint256 refund = arena.pixelFee * (count - acquired);
      currencyToken.safeTransfer(player, refund);
    }

    emit PurchasePixels(player, arenaId, teamB, count, acquired);
  }

  /// @notice Returns the price of a draw in ETH wei.
  /// @return The price of a draw in ETH wei.
  function getDrawPrice() public view returns (uint256) {
    return vrfConsumer.getRequestPrice(VRF_CALLBACK_GAS_LIMIT);
  }

  /// @notice Triggers the final drawing for an arena.
  /// @dev This function call must be funded with at least the ETH value specified by
  ///   `getDrawPrice`. However, to account for slippage, it is best to fund it with a slightly
  ///   higher amount, eg. 110% of what's returned by `getDrawPrice()`. The function will
  ///   automatically refund any excess.
  /// @dev The transaction will fail if the arena is not in the `ARENA_STATE_FULL` or
  ///   `ARENA_STATE_TIMED_OUT` state.
  /// @param arenaId The ID of the arena.
  function draw(uint256 arenaId) public payable whenNotPaused nonReentrant {
    Arena storage arena = getArenaFromStorage(arenaId);
    {
      uint256 state = arena.getState();
      if (state <= ARENA_STATE_OPEN || state >= ARENA_STATE_DRAWING) {
        // we're actually OK with TIMED_OUT too, but the custom error takes only one expected state
        revert InvalidState(arenaId, state, ARENA_STATE_FULL);
      }
    }

    uint256 price = getDrawPrice();
    if (msg.value < price) {
      revert InvalidPaymentAmount(msg.value, price);
    }
    uint256 refund = msg.value - price;

    arena.vrfRequestId = vrfConsumer.requestRandomness{value: price}(VRF_CALLBACK_GAS_LIMIT);
    arenaIdsByVrfRequestId[arena.vrfRequestId] = arenaId;

    emit VRFRequest(arenaId, arena.vrfRequestId);

    if (refund > 0) {
      payable(msg.sender).sendValue(refund);
    }
  }

  /// @notice VRF callback.
  /// @param requestId The VRF request ID.
  /// @param random The random word returned by the ChainLink VRF.
  function fulfillRandomness(uint256 requestId, uint256 random) external nonReentrant {
    if (msg.sender != address(vrfConsumer)) {
      revert PermissionDenied();
    }

    uint256 arenaId = arenaIdsByVrfRequestId[requestId];
    Arena storage arena = getArenaAndCheckState(arenaId, ARENA_STATE_DRAWING);
    assert(arena.vrfRequestId == requestId);
    delete arenaIdsByVrfRequestId[requestId];

    (uint256 winner, uint256 revenue) = arena.draw(random);
    protocolRevenue += revenue;

    emit ArenaClosure(arenaId, requestId, winner);
  }

  /// @notice Swaps the revenue collected by the protocol so far and burns it.
  /// @param minPixelAmount The minimum amount of pixel tokens the revenue is swapped for. This
  ///   protects against sandwich attacks and other cases of high slippage.
  function burnRevenue(uint256 minPixelAmount) public onlyOwner {
    uint256 pixelAmount = abi.decode(poolManager.unlock(abi.encode(protocolRevenue)), (uint256));
    if (pixelAmount < minPixelAmount) {
      revert SlippageTooHigh(pixelAmount, minPixelAmount);
    }
    pixelToken.burn(pixelAmount);
    protocolRevenue = 0;
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
      zeroForOne ? SafeCast.toUint256(delta.amount1()) : SafeCast.toUint256(delta.amount0());
    Currency currencyOut = zeroForOne ? swapPoolKey.currency1 : swapPoolKey.currency0;
    poolManager.take(currencyOut, address(this), pixelAmount);

    return abi.encode(pixelAmount);
  }

  /// @notice Returns all prizes for an arena.
  /// @param arenaId The arena ID.
  /// @return The prize breakdown.
  function getAllPrizes(uint256 arenaId) public view returns (Prizes memory) {
    Arena storage arena = getArenaAndCheckState(arenaId, ARENA_STATE_DRAWN);
    return arena.getAllPrizes();
  }

  /// @notice Returns all prizes for a given player from an arena.
  /// @param arenaId The arena ID.
  /// @param player The player to query.
  /// @return The prize breakdown.
  function getPrizesFor(uint256 arenaId, address player) public view returns (Prizes memory) {
    Arena storage arena = getArenaAndCheckState(arenaId, ARENA_STATE_DRAWN);
    return arena.getPrizesFor(player);
  }

  /// @notice Returns the total prize won by a player in an arena. This is the sum of all prizes
  ///   returned by `getPrizesFor`.
  /// @dev Reverts if the arena hasn't received its draw yet.
  /// @param arenaId The arena ID.
  /// @param player The player's address.
  /// @return The queried prize.
  function getPrizeFor(uint256 arenaId, address player) public view returns (uint256) {
    Arena storage arena = getArenaAndCheckState(arenaId, ARENA_STATE_DRAWN);
    return arena.getTotalPrizeFor(player);
  }

  /// @notice Returns the prize amount that has already been withdrawn by the player.
  /// @param arenaId The arena ID.
  /// @return The withdrawn prize amount.
  function getWithdrawnPrizeAmount(uint256 arenaId) public view returns (uint256) {
    address player = msg.sender;
    Arena storage arena = getArenaAndCheckState(arenaId, ARENA_STATE_DRAWN);
    return arena.withdrawals[player];
  }

  /// @notice Withdraws the prize for the caller from the specified arena, if any.
  /// @dev The amount returned by `getPrize` for the same arena is transferred to the caller if it
  ///   hasn't been transferred before. If the amount is zero (ie. the player didn't win anything
  ///   from that arena) the transaction is reverted.
  /// @param arenaId The arena ID.
  function withdrawPrize(uint256 arenaId) public whenNotPaused nonReentrant {
    address player = msg.sender;
    Arena storage arena = getArenaAndCheckState(arenaId, ARENA_STATE_DRAWN);
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
