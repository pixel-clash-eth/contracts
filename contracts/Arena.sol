// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {ReferralHeap, ReferralHeapMethods, ReferralRevenue} from "./Heap.sol";

// Arena states.
uint256 constant ARENA_STATE_OPEN = 0;
uint256 constant ARENA_STATE_FULL = 1;
uint256 constant ARENA_STATE_TIMED_OUT = 2;
uint256 constant ARENA_STATE_DRAWING = 3;
uint256 constant ARENA_STATE_DRAWN = 4;

// NOTE: all following prizes are expressed as a percentage of the total arena revenue. Prizes add
// up to 95% of the revenue, with the remaining 5% being the protocol fee.
uint256 constant WINNER_PRIZE = 45;
uint256 constant TEAM_PRIZE = 25;
uint256 constant SPONSOR_PRIZE = 10;
uint256 constant TOP_REFERRAL_PRIZE_1 = 6;
uint256 constant TOP_REFERRAL_PRIZE_2 = 3;
uint256 constant TOP_REFERRAL_PRIZE_3 = 1;
uint256 constant ARENA_OWNER_PRIZE = 5;

/// A range of pixels in an arena.
///
/// `offset+length` must be less than or equal to the grid size of the arena.
struct Range {
  /// The owner of the range.
  address owner;
  /// Zero-based offset of the range. For team A this is the offset from the beginning of the grid,
  /// while for team B it's the offset from the end.
  uint256 offset;
  /// Length of the range.
  uint256 length;
  /// The referrer address, or the zero address if the range was purchased without a referrer.
  address referrer;
}

struct Arena {
  /// The time at which the arena was created. This is in seconds because it's taken from
  /// `block.timestamp`.
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
  /// The price of a single pixel in this arena.
  uint256 pixelFee;
  /// The maximum duration of the arena, in seconds. The arena automatically times out if it doesn't
  /// get filled before `creationTimestamp + maxDuration`.
  uint256 maxDuration;
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
  /// Keeps track of all referrers for the arena and allow retrieving the top 3 efficiently.
  ReferralHeap referrals;
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

/// Arena prize breakdown.
///
/// Used for data retrieval, both relatively to an individual player and a whole arena.
struct Prizes {
  uint256 winnerPrize;
  uint256 teamPrize;
  uint256 sponsorPrize;
  uint256 topReferralPrize;
  uint256 arenaOwnerPrize;
}

/// Contains a subset of `Arena`'s fields. Suitable for data retrieval.
struct ArenaData {
  uint256 creationTimestamp;
  address owner;
  string teamAName;
  string teamALogo;
  bytes32 teamALogoCid;
  uint32 teamAColor;
  string teamBName;
  string teamBLogo;
  bytes32 teamBLogoCid;
  uint32 teamBColor;
  uint256 gridSize;
  uint256 pixelFee;
  uint256 maxDuration;
  uint256 state;
  uint256 teamACount;
  uint256 teamBCount;
  uint256 revenue;
  uint256 balance;
  uint256 vrfRequestId;
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
  uint256 pixelFee;
  uint256 maxDuration;
}

library ArenaMethods {
  using ReferralHeapMethods for ReferralHeap;

  /// Returns the number of pixels acquired by team A.
  function getTeamACount(Arena storage arena) public view returns (uint256) {
    if (arena.teamA.length > 0) {
      Range storage lastRange = arena.teamA[arena.teamA.length - 1];
      return lastRange.offset + lastRange.length;
    } else {
      return 0;
    }
  }

  /// Returns the number of pixels acquired by team B.
  function getTeamBCount(Arena storage arena) public view returns (uint256) {
    if (arena.teamB.length > 0) {
      Range storage lastRange = arena.teamB[arena.teamB.length - 1];
      return lastRange.offset + lastRange.length;
    } else {
      return 0;
    }
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
    return block.timestamp >= arena.creationTimestamp + arena.maxDuration;
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
  /// This function will attempt to acquire `count` pixels, but if less are available in the gap
  /// range it will only acquire the available ones and return the number of acquired pixels. The
  /// revenue and balance of the arena will be updated according to the number of effectively
  /// acquired pixels.
  ///
  /// @param arena The `Arena` instance.
  /// @param player Address of the player acquiring the pixels.
  /// @param count The number of pixels to acquire.
  /// @param teamB Whether tha player is playing in team A or B. If true, the pixels will be
  ///   acquired by team B, otherwise they'll be acquire by team A.
  /// @param referrer The referrer's address, or the zero address if this purchase wasn't referred.
  /// @return acquired The number of acquired pixels, which may be less than `count` if less were
  ///   available.
  function acquirePixels(
    Arena storage arena,
    address player,
    uint256 count,
    bool teamB,
    address referrer
  ) internal returns (uint256 acquired) {
    assert(player != referrer);
    uint256 teamACount = getTeamACount(arena);
    uint256 teamBCount = getTeamBCount(arena);
    assert(teamACount + teamBCount < arena.gridSize);
    uint256 availablePixels = arena.gridSize - teamACount - teamBCount;
    acquired = availablePixels < count ? availablePixels : count;
    if (teamB) {
      arena.teamB.push(
        Range({owner: player, offset: teamBCount, length: acquired, referrer: referrer})
      );
      arena.teamBShares[player] += acquired;
    } else {
      arena.teamA.push(
        Range({owner: player, offset: teamACount, length: acquired, referrer: referrer})
      );
      arena.teamAShares[player] += acquired;
    }
    uint256 fee = arena.pixelFee * acquired;
    arena.revenue += fee;
    arena.balance += fee;
    if (referrer != address(0)) {
      arena.referrals.addReferral(referrer, fee);
    }
  }

  /// Returns the owner of a given pixel.
  ///
  /// @param arena The `Arena` instance.
  /// @param index The zero-based index of the pixel to query. Must be strictly less than
  ///   `arena.gridSize`.
  /// @return owner The owner of the pixel, or the zero address if the pixel is in the gap.
  /// @return teamB Whether the pixel has been acquired by team A or B. Ignore this value if the
  ///   pixel is in the gap.
  /// @return referrer The referrer through which the pixel was purchased, or zero if the pixel
  ///   wasn't purchased through a referral.
  function getPixelOwner(
    Arena storage arena,
    uint256 index
  ) public view returns (address owner, bool teamB, address referrer) {
    uint256 teamACount = getTeamACount(arena);
    uint256 teamBCount = getTeamBCount(arena);
    assert(index < arena.gridSize);
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
          return (range.owner, false, range.referrer);
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
          return (range.owner, true, range.referrer);
        }
      }
    } else {
      // index is in the gap
      return (address(0), false, address(0));
    }
    // we should never get here
    assert(false);
  }

  /// Returns the referral revenue generated by a specific referrer.
  ///
  /// Returns zero if the specified address hasn't referred any purchase.
  ///
  /// @param arena The `Arena` instance.
  /// @param referrer The queried referrer address.
  /// @return The generated revenue.
  function getReferralRevenueFrom(
    Arena storage arena,
    address referrer
  ) public view returns (uint256) {
    return arena.referrals.getRevenueFrom(referrer);
  }

  /// Returns the top three referrers by generated revenue, along with their respective generated
  /// revenues.
  ///
  /// The returned elements are sorted in descending order (ie. the first one is the top referrer,
  /// the one that generated the most revenue).
  ///
  /// Note that less than 3 elements may be returned if an arena has had less than 3 referrers (not
  /// referrals!) so far. For this function to return at least 3 elements, at least 3 different
  /// addresses must have successfully referred other players.
  ///
  /// @param arena The `Arena` instance.
  /// @return The 3 referrers.
  function getTop3Referrers(Arena storage arena) public view returns (ReferralRevenue[] memory) {
    return arena.referrals.getTop3();
  }

  /// Picks the arena winner and transitions into the "drawn" state.
  ///
  /// @param arena The `Arena` instance.
  /// @param random The random word returned by the ChainLink VRF.
  /// @return winner The zero-based index of the winner (same as `arena.winner`).
  /// @return revenue The protocol revenue from the arena after deducting all prizes.
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

  /// Whether team A won.
  function teamAWins(Arena storage arena) public view returns (bool) {
    assert(getState(arena) >= ARENA_STATE_DRAWN);
    uint256 teamACount = getTeamACount(arena);
    return uint256(arena.winner) < teamACount;
  }

  /// Whether team B won.
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
  function getTeamPrizeFor(Arena storage arena, address player) public view returns (uint256) {
    assert(getState(arena) >= ARENA_STATE_DRAWN);
    bool teamB = teamBWins(arena);
    uint256 teamPixels = teamB ? getTeamBCount(arena) : getTeamACount(arena);
    uint256 playerPixels = teamB ? arena.teamBShares[player] : arena.teamAShares[player];
    return (arena.revenue * TEAM_PRIZE * playerPixels) / (100 * teamPixels);
  }

  function getSponsorPrizeImpl(
    Arena storage arena,
    address referrer
  ) private view returns (uint256) {
    if (referrer != address(0)) {
      return (arena.revenue * SPONSOR_PRIZE) / 100;
    } else {
      return 0;
    }
  }

  /// Returns the prize for the referrer of the winner, or zero if the winner had no referrer.
  function getSponsorPrize(Arena storage arena) public view returns (uint256) {
    assert(getState(arena) >= ARENA_STATE_DRAWN);
    (, , address referrer) = getPixelOwner(arena, uint256(arena.winner));
    return getSponsorPrizeImpl(arena, referrer);
  }

  function getTopReferralPrize1(Arena storage arena) public view returns (uint256) {
    assert(getState(arena) >= ARENA_STATE_TIMED_OUT);
    if (arena.referrals.length() > 0) {
      return (arena.revenue * TOP_REFERRAL_PRIZE_1) / 100;
    } else {
      return 0;
    }
  }

  function getTopReferralPrize2(Arena storage arena) public view returns (uint256) {
    assert(getState(arena) >= ARENA_STATE_TIMED_OUT);
    if (arena.referrals.length() > 1) {
      return (arena.revenue * TOP_REFERRAL_PRIZE_2) / 100;
    } else {
      return 0;
    }
  }

  function getTopReferralPrize3(Arena storage arena) public view returns (uint256) {
    assert(getState(arena) >= ARENA_STATE_TIMED_OUT);
    if (arena.referrals.length() > 2) {
      return (arena.revenue * TOP_REFERRAL_PRIZE_3) / 100;
    } else {
      return 0;
    }
  }

  function getTopReferralPrize(Arena storage arena) public view returns (uint256) {
    return getTopReferralPrize1(arena) + getTopReferralPrize2(arena) + getTopReferralPrize3(arena);
  }

  function getTopReferralPrizeFor(
    Arena storage arena,
    address player
  ) public view returns (uint256) {
    assert(getState(arena) >= ARENA_STATE_TIMED_OUT);
    ReferralRevenue[] memory referrers = arena.referrals.getTop3();
    if (referrers.length > 0 && referrers[0].referrer == player) {
      return (arena.revenue * TOP_REFERRAL_PRIZE_1) / 100;
    }
    if (referrers.length > 1 && referrers[1].referrer == player) {
      return (arena.revenue * TOP_REFERRAL_PRIZE_2) / 100;
    }
    if (referrers.length > 2 && referrers[2].referrer == player) {
      return (arena.revenue * TOP_REFERRAL_PRIZE_3) / 100;
    }
    delete referrers;
    return 0;
  }

  /// Returns the prize for the arena owner, which is a fixed percentage of the revenue regardless
  /// of the winning team.
  function getArenaOwnerPrize(Arena storage arena) public view returns (uint256) {
    assert(getState(arena) >= ARENA_STATE_TIMED_OUT);
    return (arena.revenue * ARENA_OWNER_PRIZE) / 100;
  }

  /// Returns all prizes for the arena.
  function getAllPrizes(Arena storage arena) public view returns (Prizes memory) {
    assert(getState(arena) >= ARENA_STATE_DRAWN);
    return
      Prizes({
        winnerPrize: getWinnerPrize(arena),
        teamPrize: getTeamPrize(arena),
        sponsorPrize: getSponsorPrize(arena),
        topReferralPrize: getTopReferralPrize(arena),
        arenaOwnerPrize: getArenaOwnerPrize(arena)
      });
  }

  /// Returns the sum of all prizes for the arena.
  function getTotalPrizes(Arena storage arena) public view returns (uint256) {
    Prizes memory prizes = getAllPrizes(arena);
    return
      prizes.winnerPrize +
      prizes.teamPrize +
      prizes.sponsorPrize +
      prizes.topReferralPrize +
      prizes.arenaOwnerPrize;
  }

  /// Returns the prizes won by a player in this arena.
  function getPrizesFor(Arena storage arena, address player) public view returns (Prizes memory) {
    assert(getState(arena) >= ARENA_STATE_DRAWN);
    (address winner, , address referrer) = getPixelOwner(arena, uint256(arena.winner));
    return
      Prizes({
        winnerPrize: (player != winner) ? 0 : getWinnerPrize(arena),
        teamPrize: getTeamPrizeFor(arena, player),
        sponsorPrize: (player != referrer) ? 0 : getSponsorPrizeImpl(arena, referrer),
        topReferralPrize: getTopReferralPrizeFor(arena, player),
        arenaOwnerPrize: (player != arena.owner) ? 0 : getArenaOwnerPrize(arena)
      });
  }

  /// Returns the sum of all prizes for a given player from this arena.
  function getTotalPrizeFor(Arena storage arena, address player) public view returns (uint256) {
    Prizes memory prizes = getPrizesFor(arena, player);
    return
      prizes.winnerPrize +
      prizes.teamPrize +
      prizes.sponsorPrize +
      prizes.topReferralPrize +
      prizes.arenaOwnerPrize;
  }
}
