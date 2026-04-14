// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IUniswapV3Pool} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import {ISwapRouter} from "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";

import {SwapGateway} from "./SwapGateway.sol";

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

// Base fee for arena creation in USD cents. Currently $25.
uint256 constant BASE_ARENA_CREATION_FEE = 2500;

// Pixels that are always assigned to the arena owner upon creation.
//
// NOTE: This number must be divisible by 2 because half of these are assigned from team A and half
// from team B.
uint256 constant INITIAL_PIXELS = 10;

// ChainLink VRF callback gas limit.
uint32 constant VRF_CALLBACK_GAS_LIMIT = 1_000_000;

// Referral discount: buyers who provide a referrer pay 10% less.
uint256 constant REFERRAL_DISCOUNT_NUMERATOR = 9;
uint256 constant REFERRAL_DISCOUNT_DENOMINATOR = 10;

// Represents a generic ERC-20 token with ERC-2612 permits.
//
// We use this type of token as currency for all payments and prizes in the game.
interface ICurrencyToken is IERC20, IERC20Metadata, IERC20Permit {}

contract PixelClash is
  Initializable,
  AccessControlUpgradeable,
  PausableUpgradeable,
  ReentrancyGuardTransient,
  UUPSUpgradeable,
  VRFClient
{
  bytes32 public constant UPGRADE_ROLE = keccak256("UPGRADE_ROLE");
  bytes32 public constant PAUSE_ROLE = keccak256("PAUSE_ROLE");
  bytes32 public constant CONFIG_ROLE = keccak256("CONFIG_ROLE");

  using Address for address payable;
  using ArenaMethods for Arena;
  using EnumerableSet for EnumerableSet.UintSet;
  using SafeERC20 for ICurrencyToken;

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
  error InvalidPaymentAmount(uint256 got, uint256 want);
  error InvalidArenaId(uint256 id);
  error InvalidArgument();
  error InvalidState(uint256 arenaId, uint256 got, uint256 want);
  error NoPrize(uint256 arenaId, address player);
  error PermissionDenied();
  error SelfReferralForbidden();

  /// @notice All payments and prizes are in this token.
  ICurrencyToken public currencyToken;

  /// @notice ChainLink VRF consumer.
  VRFConsumer public vrfConsumer;

  /// @notice Takes care of swapping and burning the revenue.
  SwapGateway public swapGateway;

  /// @notice List of arenas.
  Arena[] private arenas;

  /// @notice Arena IDs indexed by owner.
  mapping(address => uint256[]) private _arenaIdsByOwner;

  /// @notice Arena IDs indexed by tag.
  mapping(string => uint256[]) private _arenaIdsByTag;

  /// @notice Arena IDs indexed by the address of anyone who played in them.
  mapping(address => EnumerableSet.UintSet) private _arenaIdsByPlayer;

  /// @notice Protocol revenue in `currencyToken`.
  uint256 public protocolRevenue;

  /// @notice Numerator of the maximum allowed price slippage during revenue swaps.
  /// @dev For instance, set the numerator to 1 and the denominator to 100 for a 1% slippage
  ///   tolerance.
  uint256 public maxSlippageNumerator;

  /// @notice Denominator of the maximum allowed price slippage during revenue swaps.
  /// @dev For instance, set the numerator to 1 and the denominator to 100 for a 1% slippage
  ///   tolerance.
  uint256 public maxSlippageDenominator;

  /// @notice Arena IDs indexed by VRF request ID. Used to retrieve the correct arena in the VRF
  ///   callback.
  mapping(uint256 => uint256) public arenaIdsByVrfRequestId;

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor() {
    _disableInitializers();
  }

  function initialize(
    address defaultAdmin,
    ICurrencyToken currencyToken_,
    address vrfCoordinator_,
    SwapGateway swapGateway_
  ) public initializer {
    __AccessControl_init();
    __Pausable_init();

    _grantRole(DEFAULT_ADMIN_ROLE, defaultAdmin);
    _grantRole(UPGRADE_ROLE, defaultAdmin);
    _grantRole(PAUSE_ROLE, defaultAdmin);
    _grantRole(CONFIG_ROLE, defaultAdmin);

    currencyToken = currencyToken_;
    vrfConsumer = new VRFConsumer(vrfCoordinator_);
    swapGateway = swapGateway_;

    // Skip arena #0 because ID 0 is conventionally invalid.
    arenas.push();

    maxSlippageNumerator = 1;
    maxSlippageDenominator = 100;
  }

  function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADE_ROLE) {}

  function pause() public onlyRole(PAUSE_ROLE) {
    _pause();
  }

  function unpause() public onlyRole(PAUSE_ROLE) {
    _unpause();
  }

  /// @notice Configures the maximum tolerated slippage for protocol revenue swaps.
  /// @dev For example, setting the `numerator` to 1 and the `denominator` to 100 results in a 1%
  ///   tolerance.
  /// @param numerator The numerator part of the maximum slippage tolerance, eg. 1.
  /// @param denominator The denominator part of the maximum slippage tolerance, eg. 100.
  function setMaxSlippage(uint256 numerator, uint256 denominator) public onlyRole(CONFIG_ROLE) {
    if (denominator == 0 || numerator >= denominator) {
      revert InvalidArgument();
    }
    maxSlippageNumerator = numerator;
    maxSlippageDenominator = denominator;
  }

  function arenaCreationFee(uint256 pixelFee) public view returns (uint256) {
    return
      pixelFee * INITIAL_PIXELS +
      (BASE_ARENA_CREATION_FEE * (10 ** currencyToken.decimals())) / 100;
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

  /// @notice Returns the total number of arenas that have been created.
  /// @return The number of arenas.
  function getArenaCount() public view returns (uint256) {
    return arenas.length - 1;
  }

  /// @notice Retrieves the state of the given arena.
  /// @param arenaId The arena ID.
  /// @return An `ArenaData` containing most of the state of the arena.
  function getArenaData(uint256 arenaId) public view returns (ArenaData memory) {
    Arena storage arena = getArenaFromStorage(arenaId);
    return arena.getData();
  }

  function getArenaIds(
    uint256[] storage ids,
    uint256 offset,
    uint256 count
  ) private view returns (uint256[] memory result) {
    uint256 total = ids.length;
    if (offset >= total) {
      return new uint256[](0);
    }
    uint256 available = total - offset;
    uint256 size = available < count ? available : count;
    result = new uint256[](size);
    for (uint256 i = 0; i < size; ++i) {
      result[i] = ids[total - 1 - offset - i];
    }
  }

  /// @notice Returns the IDs of the arenas created by a specific user.
  /// @dev The IDs are returned in reverse creation order.
  /// @dev The `offset` and `count` parameters are used for paging.
  /// @return An array containing at most `count` IDs.
  function getUserArenas(
    address user,
    uint256 offset,
    uint256 count
  ) public view returns (uint256[] memory) {
    return getArenaIds(_arenaIdsByOwner[user], offset, count);
  }

  /// @notice Returns the IDs of the arenas associated with the specified tag.
  /// @dev The IDs are returned in reverse creation order.
  /// @dev The `offset` and `count` parameters are used for paging.
  /// @return ids An array containing at most `count` IDs.
  function getArenasByTag(
    string calldata tag,
    uint256 offset,
    uint256 count
  ) public view returns (uint256[] memory ids) {
    return getArenaIds(_arenaIdsByTag[tag], offset, count);
  }

  /// @notice Returns the IDs of arenas the specified player has participated in.
  /// @dev The IDs are returned in reverse participation order.
  /// @dev The `offset` and `count` parameters are used for paging.
  /// @return ids An array containing at most `count` IDs.
  function getArenasByPlayer(
    address player,
    uint256 offset,
    uint256 count
  ) public view returns (uint256[] memory ids) {
    EnumerableSet.UintSet storage set = _arenaIdsByPlayer[player];
    uint256 total = set.length();
    if (offset >= total) {
      return new uint256[](0);
    }
    uint256 available = total - offset;
    uint256 size = available < count ? available : count;
    ids = new uint256[](size);
    for (uint256 i = 0; i < size; ++i) {
      ids[i] = set.at(total - 1 - offset - i);
    }
  }

  /// @notice Returns the range including the given pixel.
  /// @param arenaId The arena ID.
  /// @param index The zero-based index of the pixel to query. Must be strictly less than the
  ///   `gridSize` of the arena.
  /// @return range The range including the pixel, or an empty range if the pixel is in the gap. The
  ///   caller can check whether the pixel is in the gap by checking the `owner` of the range
  ///   against the zero address, because a regular range will never have the owner set to zero.
  /// @return teamB Whether the pixel has been acquired by team A or B. Ignore this value if the
  ///   pixel is in the gap.
  function getPixelRange(
    uint256 arenaId,
    uint256 index
  ) public view returns (Range memory range, bool teamB) {
    Arena storage arena = getArenaFromStorage(arenaId);
    return arena.getPixelRange(index);
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
  /// @dev Payment of a fee equal to `ARENA_CREATION_FEE` plus the cost of `INITIAL_PIXELS` is
  ///   required. The creator of the arena automatically becomes the owner of `INITIAL_PIXELS / 2`
  ///   pixels in team A and `INITIAL_PIXELS / 2` pixel in team B. The payment is carried out via an
  ///   ERC-2612 signature.
  /// @param params The arena creation parameters.
  /// @param deadline The deadline of the ERC-2612 signature.
  /// @param v The `v` parameter of the ERC-2612 signature.
  /// @param r The `r` parameter of the ERC-2612 signature.
  /// @param s The `s` parameter of the ERC-2612 signature.
  function createArenaWithPermit(
    CreateArenaParams calldata params,
    string[] calldata tags,
    uint256 deadline,
    uint8 v,
    bytes32 r,
    bytes32 s
  ) public whenNotPaused nonReentrant {
    address owner = msg.sender;
    uint256 fee = arenaCreationFee(params.pixelFee);
    uint256 numPixelsPerTeam = INITIAL_PIXELS / 2;
    try currencyToken.permit(owner, address(this), fee, deadline, v, r, s) {} catch {}
    currencyToken.safeTransferFrom(owner, address(this), fee);

    uint256 id = arenas.length;
    arenas.push();
    Arena storage arena = arenas[id];
    arena.initialize(owner, numPixelsPerTeam, params);
    protocolRevenue += fee;

    _arenaIdsByOwner[owner].push(id);
    _arenaIdsByPlayer[owner].add(id);
    for (uint256 i = 0; i < tags.length; ++i) {
      _arenaIdsByTag[tags[i]].push(id);
    }

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

    uint256 effectivePixelFee =
      (referrer != address(0))
        ? (arena.pixelFee * REFERRAL_DISCOUNT_NUMERATOR) / REFERRAL_DISCOUNT_DENOMINATOR
        : arena.pixelFee;

    uint256 fee = effectivePixelFee * count;
    try currencyToken.permit(player, address(this), fee, deadline, v, r, s) {} catch {}
    currencyToken.safeTransferFrom(player, address(this), fee);

    uint256 acquired = arena.acquirePixels(player, count, teamB, referrer, effectivePixelFee);
    if (acquired < count) {
      uint256 refund = effectivePixelFee * (count - acquired);
      currencyToken.safeTransfer(player, refund);
    }

    _arenaIdsByPlayer[player].add(arenaId);

    emit PurchasePixels(player, arenaId, teamB, count, acquired);
  }

  /// @notice Returns the price of a draw in ETH wei.
  /// @return The price of a draw in ETH wei.
  function getDrawPrice() public view returns (uint256) {
    return vrfConsumer.getRequestPrice(VRF_CALLBACK_GAS_LIMIT);
  }

  /// @notice Triggers the final drawing for an arena.
  /// @dev This function is permissionless, meaning that anyone can trigger the drawing of a
  ///   drawable arena, not just the arena owner.
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
    revenue += protocolRevenue;
    protocolRevenue = 0;
    currencyToken.forceApprove(address(swapGateway), revenue);
    try swapGateway.swapAndBurn(revenue, maxSlippageNumerator, maxSlippageDenominator) {} catch {
      protocolRevenue = revenue;
    }

    emit ArenaClosure(arenaId, requestId, winner);
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
