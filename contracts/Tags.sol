// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

// Tag limits. Tags are canonical: 1-32 bytes, no spaces, ASCII control characters or uppercase
// ASCII letters, so that eg. "Football" and "football" can't become two different tags.
uint256 constant MAX_TAGS_PER_ARENA = 3;
uint256 constant MAX_TAG_LENGTH = 32;

/// @notice Global tag index: the catalog of distinct tags, the arenas of each tag and the tags of
///   each arena.
/// @dev Deployed as an external library to keep `PixelClash` below the contract size limit.
library TagMethods {
  error InvalidTag(string tag);
  error TooManyTags(uint256 count);

  /// @notice Validates the tags of a new arena and adds them to the index.
  /// @param catalog All distinct tags, in order of first use.
  /// @param arenaIdsByTag Arena IDs indexed by tag.
  /// @param arenaTags The tags of the new arena. Must be empty.
  /// @param arenaId The ID of the new arena. Must be greater than all IDs already in the index.
  /// @param tags Up to `MAX_TAGS_PER_ARENA` distinct canonical tags.
  function addArenaTags(
    string[] storage catalog,
    mapping(string => uint256[]) storage arenaIdsByTag,
    string[] storage arenaTags,
    uint256 arenaId,
    string[] calldata tags
  ) external {
    if (tags.length > MAX_TAGS_PER_ARENA) {
      revert TooManyTags(tags.length);
    }
    for (uint256 i = 0; i < tags.length; ++i) {
      string calldata tag = tags[i];
      checkTag(tag);
      uint256[] storage ids = arenaIdsByTag[tag];
      uint256 length = ids.length;
      if (length == 0) {
        catalog.push(tag);
      } else if (ids[length - 1] == arenaId) {
        // duplicate tag in the same arena
        revert InvalidTag(tag);
      }
      ids.push(arenaId);
      arenaTags.push(tag);
    }
  }

  function checkTag(string calldata tag) private pure {
    bytes calldata chars = bytes(tag);
    if (chars.length == 0 || chars.length > MAX_TAG_LENGTH) {
      revert InvalidTag(tag);
    }
    for (uint256 i = 0; i < chars.length; ++i) {
      bytes1 c = chars[i];
      if (c <= 0x20 || c == 0x7F || (c >= 0x41 && c <= 0x5A)) {
        revert InvalidTag(tag);
      }
    }
  }

  /// @notice Returns `size` tags of the catalog starting at `offset`, along with the number of
  ///   arenas using each of them. The caller must ensure that `offset + size` is within bounds.
  function getTags(
    string[] storage catalog,
    mapping(string => uint256[]) storage arenaIdsByTag,
    uint256 offset,
    uint256 size
  ) external view returns (string[] memory tags, uint256[] memory arenaCounts) {
    tags = new string[](size);
    arenaCounts = new uint256[](size);
    for (uint256 i = 0; i < size; ++i) {
      tags[i] = catalog[offset + i];
      arenaCounts[i] = arenaIdsByTag[tags[i]].length;
    }
  }
}
