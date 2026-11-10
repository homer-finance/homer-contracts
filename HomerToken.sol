// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @title $HOMER
/// @notice Fixed supply, minted once to `recipient`. No owner, no minting, no taxes, no blacklist.
contract HomerToken is ERC20, ERC20Burnable {
    bytes32 public constant KIND = "HomerToken";

    event HomerDeployed(bytes32 indexed kind, address indexed owner);

    constructor(string memory name_, string memory symbol_, uint256 supply, address recipient) ERC20(name_, symbol_) {
        _mint(recipient, supply);
        emit HomerDeployed(KIND, recipient);
    }
}
