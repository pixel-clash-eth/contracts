// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

contract MockToken is ERC20, ERC20Burnable, Ownable, ERC20Permit {
  constructor(address owner) ERC20("MockToken", "MTK") Ownable(owner) ERC20Permit("MockToken") {
    _mint(owner, 1e9 * 10 ** decimals());
  }

  function mint(uint256 amount) public {
    _mint(_msgSender(), amount);
  }
}
