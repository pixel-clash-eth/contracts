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
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
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
  PixelRange,
  ARENA_STATE_OPEN,
  ARENA_STATE_FULL,
  ARENA_STATE_DRAWING,
  ARENA_STATE_DRAWN
} from "./Arena.sol";

import {ReferralRevenue} from "./Referrals.sol";
import {TagMethods} from "./Tags.sol";
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

// Maximum number of elements returned by paginated views that return structs or strings. It keeps
// each `eth_call` well below the gas caps and response size limits of public RPC providers.
uint256 constant MAX_PAGE_SIZE = 100;

// Time after which a draw whose VRF callback never arrived can be requested again. It is long on
// purpose: a re-request gives the VRF provider a chance to withhold an unfavorable random word, so
// it must only serve as a recovery mechanism.
uint256 constant VRF_RETRY_DELAY = 6 hours;

// Referral codes are 3-20 characters among lowercase ASCII letters, digits, "-" and "_". The
// restricted charset keeps them URL-safe and rules out Unicode look-alikes of other codes.
uint256 constant MIN_REFERRAL_CODE_LENGTH = 3;
uint256 constant MAX_REFERRAL_CODE_LENGTH = 20;

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
  /// @param referrer The referrer's address, or the zero address if the purchase wasn't referred.
  /// @param fee The amount of currency tokens paid for the acquired pixels.
  event PurchasePixels(
    address indexed player,
    uint256 indexed arenaId,
    bool indexed teamB,
    uint256 requested,
    uint256 acquired,
    address referrer,
    uint256 fee
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

  /// @notice A referrer registered their referral code.
  /// @param referrer The referrer's address.
  /// @param code The referral code.
  event RegisterReferralCode(address indexed referrer, string code);

  error AlreadyWithdrawn(uint256 arenaId, address player);
  error DrawPending(uint256 arenaId, uint256 retryTimestamp);
  error InvalidPaymentAmount(uint256 got, uint256 want);
  error InvalidArenaId(uint256 id);
  error InvalidArgument();
  error InvalidReferralCode(string code);
  error InvalidState(uint256 arenaId, uint256 got, uint256 want);
  error NoPrize(uint256 arenaId, address player);
  error PermissionDenied();
  error ReferralCodeAlreadySet(address referrer);
  error ReferralCodeTaken(string code);
  error SelfReferralForbidden();

  /// @notice All payments and prizes are in this token.
  ICurrencyToken public currencyToken;

  /// @notice ChainLink VRF consumer.
  VRFConsumer public vrfConsumer;

  /// @notice Takes care of swapping and burning the revenue.
  SwapGateway public swapGateway;

  /// @notice List of arenas.
  Arena[] private arenas;

  // NOTE: arena ID lists are `uint64[]` because Solidity packs 4 of them per storage slot, so 3
  // out of 4 appends update an existing slot instead of writing a new one.

  /// @notice Arena IDs indexed by owner.
  mapping(address => uint64[]) private _arenaIdsByOwner;

  /// @notice Arena IDs indexed by tag.
  mapping(string => uint64[]) private _arenaIdsByTag;

  /// @notice Arena IDs indexed by the address of anyone who played in them, in order of first
  ///   participation.
  mapping(address => uint64[]) private _arenaIdsByPlayer;

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

  // NOTE: once deployed, new storage variables must always be appended at the end, and per-arena
  // data must not be added to the `Arena` struct, because arenas are stored in an array and growing
  // the struct would shift existing arenas. The layout above changed (packed ID lists and `Range`)
  // before the first production deployment, so it is not compatible with earlier test deployments.

  /// @notice All distinct tags, in order of first use. The ID of a tag is its index + 1.
  string[] private _tags;

  /// @notice 1-based tag IDs indexed by tag.
  mapping(string => uint256) private _tagIds;

  /// @notice Tag IDs of each arena, packed as described in `Tags.sol`, indexed by arena ID.
  mapping(uint256 => uint256) private _arenaTagIds;

  /// @notice IDs of the arenas that haven't been drawn yet.
  EnumerableSet.UintSet private _activeArenaIds;

  /// @notice Timestamp of the latest VRF request of each arena, indexed by arena ID.
  mapping(uint256 => uint256) private _drawRequestTimestamps;

  /// @notice Referrer of each referral code.
  mapping(string => address) private _referralCodeOwners;

  /// @notice Referral code of each referrer.
  mapping(address => string) private _referralCodes;

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

  /// @notice Returns how many elements a page starting at `offset` contains, given `total`
  ///   elements, at most `count` requested and at most `MAX_PAGE_SIZE` allowed.
  function getPageSize(
    uint256 total,
    uint256 offset,
    uint256 count
  ) private pure returns (uint256 size) {
    if (offset >= total) {
      return 0;
    }
    size = total - offset;
    if (size > count) {
      size = count;
    }
    if (size > MAX_PAGE_SIZE) {
      size = MAX_PAGE_SIZE;
    }
  }

  /// @notice Returns the state of several arenas at once.
  /// @dev The arenas are returned in reverse creation order (newest first).
  /// @dev The `offset` and `count` parameters are used for paging. At most `MAX_PAGE_SIZE` arenas
  ///   are returned regardless of `count`.
  /// @return ids The arena IDs.
  /// @return data The `ArenaData` of each arena in `ids`.
  function getArenas(
    uint256 offset,
    uint256 count
  ) public view returns (uint256[] memory ids, ArenaData[] memory data) {
    uint256 total = getArenaCount();
    uint256 size = getPageSize(total, offset, count);
    ids = new uint256[](size);
    data = new ArenaData[](size);
    for (uint256 i = 0; i < size; ++i) {
      ids[i] = total - offset - i;
      data[i] = arenas[ids[i]].getData();
    }
  }

  /// @notice Returns the tags of an arena, in the order they were provided at creation.
  function getArenaTags(uint256 arenaId) public view returns (string[] memory) {
    getArenaFromStorage(arenaId);
    return TagMethods.getArenaTags(_tags, _arenaTagIds[arenaId]);
  }

  /// @notice Returns the distinct tags used by all arenas, along with the number of arenas using
  ///   each of them.
  /// @dev Tags are returned in order of first use, so pages stay stable while new tags are added.
  /// @dev The `offset` and `count` parameters are used for paging. At most `MAX_PAGE_SIZE` tags
  ///   are returned regardless of `count`.
  /// @return tags The tags.
  /// @return arenaCounts The number of arenas using each tag in `tags`.
  /// @return total The total number of distinct tags.
  function getTags(
    uint256 offset,
    uint256 count
  ) public view returns (string[] memory tags, uint256[] memory arenaCounts, uint256 total) {
    total = _tags.length;
    uint256 size = getPageSize(total, offset, count);
    (tags, arenaCounts) = TagMethods.getTags(_tags, _arenaIdsByTag, offset, size);
  }

  /// @notice Returns the number of arenas associated with the specified tag.
  function getArenaCountByTag(string calldata tag) public view returns (uint256) {
    return _arenaIdsByTag[tag].length;
  }

  /// @notice Returns the IDs of the arenas that haven't been drawn yet, ie. those in the open, full,
  ///   timed out or drawing state.
  /// @dev The order is unspecified, because removing a drawn arena moves the last one in its place.
  /// @dev The `offset` and `count` parameters are used for paging. At most `MAX_PAGE_SIZE` IDs are
  ///   returned regardless of `count`.
  /// @return ids The arena IDs.
  /// @return total The total number of arenas that haven't been drawn yet.
  function getActiveArenas(
    uint256 offset,
    uint256 count
  ) public view returns (uint256[] memory ids, uint256 total) {
    total = _activeArenaIds.length();
    uint256 size = getPageSize(total, offset, count);
    ids = new uint256[](size);
    for (uint256 i = 0; i < size; ++i) {
      ids[i] = _activeArenaIds.at(offset + i);
    }
  }

  /// @notice Returns the number of pixels a player acquired in each team of an arena.
  function getPlayerPixels(
    uint256 arenaId,
    address player
  ) public view returns (uint256 teamA, uint256 teamB) {
    Arena storage arena = getArenaFromStorage(arenaId);
    return (arena.teamAShares[player], arena.teamBShares[player]);
  }

  /// @notice Returns the number of pixel purchases made in an arena, excluding the pixels assigned
  ///   to the owner at creation.
  function getPurchaseCount(uint256 arenaId) public view returns (uint256) {
    Arena storage arena = getArenaFromStorage(arenaId);
    return arena.teamA.length + arena.teamB.length - 2;
  }

  /// @notice Returns the number of arenas the specified player has participated in, including the
  ///   ones they created.
  function getArenaCountByPlayer(address player) public view returns (uint256) {
    return _arenaIdsByPlayer[player].length;
  }

  /// @notice Associates a referral code with the caller, so that referral links can use the code
  ///   instead of the address.
  /// @dev Codes are assigned first come, first served, and each address can register a single code.
  ///   Neither can be changed afterwards. Note that the association is public like any on-chain
  ///   data: the code is an alias, not a way to hide the referrer's address.
  /// @param code The referral code (see `MIN_REFERRAL_CODE_LENGTH` and `MAX_REFERRAL_CODE_LENGTH`).
  function registerReferralCode(string calldata code) public whenNotPaused {
    address referrer = msg.sender;
    if (bytes(_referralCodes[referrer]).length != 0) {
      revert ReferralCodeAlreadySet(referrer);
    }
    if (_referralCodeOwners[code] != address(0)) {
      revert ReferralCodeTaken(code);
    }
    bytes calldata chars = bytes(code);
    if (chars.length < MIN_REFERRAL_CODE_LENGTH || chars.length > MAX_REFERRAL_CODE_LENGTH) {
      revert InvalidReferralCode(code);
    }
    for (uint256 i = 0; i < chars.length; ++i) {
      bytes1 c = chars[i];
      if (!((c >= 0x61 && c <= 0x7A) || (c >= 0x30 && c <= 0x39) || c == 0x2D || c == 0x5F)) {
        revert InvalidReferralCode(code);
      }
    }
    _referralCodeOwners[code] = referrer;
    _referralCodes[referrer] = code;
    emit RegisterReferralCode(referrer, code);
  }

  /// @notice Returns the referrer of a referral code, or the zero address if it's not registered.
  function getReferralCodeOwner(string calldata code) public view returns (address) {
    return _referralCodeOwners[code];
  }

  /// @notice Returns the referral code of a referrer, or an empty string if they have none.
  function getReferralCode(address referrer) public view returns (string memory) {
    return _referralCodes[referrer];
  }

  function getArenaIds(
    uint64[] storage ids,
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
    return getArenaIds(_arenaIdsByPlayer[player], offset, count);
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
  ) public view returns (PixelRange memory range, bool teamB) {
    Arena storage arena = getArenaFromStorage(arenaId);
    return arena.getPixelRange(index);
  }

  /// @notice Returns a page of the pixel ranges of a team, in order of acquisition: the creator's
  ///   initial range, then one range per purchase. Together they list the owner of every pixel.
  /// @dev Ranges are only ever appended, so pages stay stable while pixels are purchased.
  /// @dev The `offset` and `count` parameters are used for paging. At most `MAX_PAGE_SIZE` ranges
  ///   are returned regardless of `count`.
  /// @param arenaId The arena ID.
  /// @param teamB Whether to return the ranges of team B rather than team A.
  /// @return owners The owner of each range.
  /// @return offsets The offset of each range, counted from the corner of the team.
  /// @return lengths The number of pixels of each range.
  /// @return total The total number of ranges of the team.
  function getTeamRanges(
    uint256 arenaId,
    bool teamB,
    uint256 offset,
    uint256 count
  )
    public
    view
    returns (
      address[] memory owners,
      uint256[] memory offsets,
      uint256[] memory lengths,
      uint256 total
    )
  {
    Arena storage arena = getArenaFromStorage(arenaId);
    return arena.getRanges(teamB, offset, count > MAX_PAGE_SIZE ? MAX_PAGE_SIZE : count);
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
  /// @param tags Up to `MAX_TAGS_PER_ARENA` distinct canonical tags (see `Tags.sol`).
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
  ) public whenNotPaused nonReentrant returns (uint256 id) {
    address owner = msg.sender;
    uint256 fee = arenaCreationFee(params.pixelFee);
    uint256 numPixelsPerTeam = INITIAL_PIXELS / 2;
    try currencyToken.permit(owner, address(this), fee, deadline, v, r, s) {} catch {}
    currencyToken.safeTransferFrom(owner, address(this), fee);

    id = arenas.length;
    arenas.push();
    Arena storage arena = arenas[id];
    arena.initialize(owner, numPixelsPerTeam, params);
    protocolRevenue += fee;

    uint64 id64 = SafeCast.toUint64(id);
    _arenaIdsByOwner[owner].push(id64);
    _arenaIdsByPlayer[owner].push(id64);
    _activeArenaIds.add(id);
    uint256 packedTagIds = TagMethods.addArenaTags(_tags, _tagIds, _arenaIdsByTag, id, tags);
    if (packedTagIds != 0) {
      _arenaTagIds[id] = packedTagIds;
    }

    uint256 initialFee = params.pixelFee * numPixelsPerTeam;
    emit CreateArena(owner, id);
    emit PurchasePixels(
      owner,
      id,
      false,
      numPixelsPerTeam,
      numPixelsPerTeam,
      address(0),
      initialFee
    );
    emit PurchasePixels(
      owner,
      id,
      true,
      numPixelsPerTeam,
      numPixelsPerTeam,
      address(0),
      initialFee
    );
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

    bool isNewPlayer = arena.teamAShares[player] == 0 && arena.teamBShares[player] == 0;
    uint256 acquired = arena.acquirePixels(player, count, teamB, referrer, effectivePixelFee);
    if (acquired < count) {
      uint256 refund = effectivePixelFee * (count - acquired);
      currencyToken.safeTransfer(player, refund);
    }

    if (isNewPlayer) {
      _arenaIdsByPlayer[player].push(SafeCast.toUint64(arenaId));
    }

    emit PurchasePixels(
      player,
      arenaId,
      teamB,
      count,
      acquired,
      referrer,
      effectivePixelFee * acquired
    );
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
  /// @dev If the VRF callback of a previous draw hasn't arrived within `VRF_RETRY_DELAY`, the
  ///   arena can be drawn again: the previous request is discarded and its late callback, if any,
  ///   will be rejected.
  /// @param arenaId The ID of the arena.
  function draw(uint256 arenaId) public payable whenNotPaused nonReentrant {
    Arena storage arena = getArenaFromStorage(arenaId);
    {
      uint256 state = arena.getState();
      if (state == ARENA_STATE_DRAWING) {
        uint256 retryTimestamp = _drawRequestTimestamps[arenaId] + VRF_RETRY_DELAY;
        if (block.timestamp < retryTimestamp) {
          revert DrawPending(arenaId, retryTimestamp);
        }
        delete arenaIdsByVrfRequestId[arena.vrfRequestId];
      } else if (state == ARENA_STATE_OPEN || state == ARENA_STATE_DRAWN) {
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
    _drawRequestTimestamps[arenaId] = block.timestamp;

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
    _activeArenaIds.remove(arenaId);

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
  /// @param player The player's address.
  /// @return The withdrawn prize amount.
  function getWithdrawnPrizeAmount(uint256 arenaId, address player) public view returns (uint256) {
    Arena storage arena = getArenaAndCheckState(arenaId, ARENA_STATE_DRAWN);
    return arena.withdrawals[player];
  }

  /// @notice Returns the prizes of a player in the arenas they played in, newest first like
  ///   `getArenasByPlayer`: what they won in each drawn arena and how much of it they withdrew.
  ///   Prizes never expire, so this lists every prize still to withdraw.
  /// @dev The `offset` and `count` parameters are used for paging. At most `MAX_PAGE_SIZE` arenas
  ///   are returned regardless of `count`.
  /// @param player The player.
  /// @return arenaIds The arena IDs.
  /// @return prizes The total prize of the player in each arena, zero if it isn't drawn yet.
  /// @return withdrawn The part of each prize the player already withdrew.
  /// @return total The total number of arenas the player played in.
  function getPlayerPrizes(
    address player,
    uint256 offset,
    uint256 count
  )
    public
    view
    returns (
      uint256[] memory arenaIds,
      uint256[] memory prizes,
      uint256[] memory withdrawn,
      uint256 total
    )
  {
    uint64[] storage ids = _arenaIdsByPlayer[player];
    total = ids.length;
    (arenaIds, prizes, withdrawn) = ArenaMethods.getPlayerPrizes(
      arenas,
      ids,
      player,
      offset,
      count > MAX_PAGE_SIZE ? MAX_PAGE_SIZE : count
    );
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
