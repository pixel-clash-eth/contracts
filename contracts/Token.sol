// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC1363} from "@openzeppelin/contracts/token/ERC20/extensions/ERC1363.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20FlashMint} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20FlashMint.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";

contract Token is ERC20, ERC20Burnable, ERC1363, ERC20Permit, ERC20Votes, ERC20FlashMint {
  constructor(address recipient) ERC20("PixelClash", "PXC") ERC20Permit("PixelClash") {
    _mint(recipient, 1_000_000_000 * 10 ** decimals());
  }

  // The following functions are overrides required by Solidity.

  function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Votes) {
    super._update(from, to, value);
  }

  function nonces(address owner) public view override(ERC20Permit, Nonces) returns (uint256) {
    return super.nonces(owner);
  }
}
