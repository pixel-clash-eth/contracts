// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

// Tag limits. Tags are canonical: 1-32 bytes, no spaces, ASCII control characters or uppercase
// ASCII letters, so that eg. "Football" and "football" can't become two different tags.
uint256 constant MAX_TAGS_PER_ARENA = 3;
uint256 constant MAX_TAG_LENGTH = 32;

// The tags of an arena are stored as up to `MAX_TAGS_PER_ARENA` 1-based tag IDs packed in a single
// storage slot, `TAG_ID_BITS` bits each, so that an arena never stores a copy of its tag strings.
uint256 constant TAG_ID_BITS = 64;

/// @notice Global tag index: the catalog of distinct tags, the arenas of each tag and the tags of
///   each arena.
/// @dev Deployed as an external library to keep `PixelClash` below the contract size limit.
library TagMethods {
  error InvalidTag(string tag);
  error TooManyTags(uint256 count);

  /// @notice Validates the tags of a new arena and adds them to the index.
  /// @param catalog All distinct tags, in order of first use. The ID of a tag is its index + 1.
  /// @param tagIds 1-based tag IDs indexed by tag.
  /// @param arenaIdsByTag Arena IDs indexed by tag.
  /// @param arenaId The ID of the new arena. Must be greater than all IDs already in the index.
  /// @param tags Up to `MAX_TAGS_PER_ARENA` distinct canonical tags.
  /// @return packedTagIds The IDs of `tags`, packed as described at `TAG_ID_BITS`.
  function addArenaTags(
    string[] storage catalog,
    mapping(string => uint256) storage tagIds,
    mapping(string => uint64[]) storage arenaIdsByTag,
    uint256 arenaId,
    string[] calldata tags
  ) external returns (uint256 packedTagIds) {
    if (tags.length > MAX_TAGS_PER_ARENA) {
      revert TooManyTags(tags.length);
    }
    uint64 id64 = SafeCast.toUint64(arenaId);
    for (uint256 i = 0; i < tags.length; ++i) {
      string calldata tag = tags[i];
      uint256 tagId = tagIds[tag];
      uint64[] storage ids = arenaIdsByTag[tag];
      if (tagId == 0) {
        checkTag(tag);
        catalog.push(tag);
        tagId = catalog.length;
        tagIds[tag] = tagId;
      } else if (ids[ids.length - 1] == id64) {
        // duplicate tag in the same arena
        revert InvalidTag(tag);
      }
      ids.push(id64);
      packedTagIds |= tagId << (i * TAG_ID_BITS);
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

  /// @notice Returns the tags whose IDs are packed in `packedTagIds`, in the order they were given.
  function getArenaTags(
    string[] storage catalog,
    uint256 packedTagIds
  ) external view returns (string[] memory tags) {
    uint256 count = 0;
    while (count < MAX_TAGS_PER_ARENA && (packedTagIds >> (count * TAG_ID_BITS)) != 0) {
      ++count;
    }
    tags = new string[](count);
    for (uint256 i = 0; i < count; ++i) {
      uint256 tagId = uint64(packedTagIds >> (i * TAG_ID_BITS));
      tags[i] = catalog[tagId - 1];
    }
  }

  /// @notice Returns `size` tags of the catalog starting at `offset`, along with the number of
  ///   arenas using each of them. The caller must ensure that `offset + size` is within bounds.
  function getTags(
    string[] storage catalog,
    mapping(string => uint64[]) storage arenaIdsByTag,
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
