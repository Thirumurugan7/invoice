// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Demo yen stablecoin (NOT the real JPYC). Issuer-minted, 18 decimals.
/// On Sepolia the real JPYC (0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29) can be used instead.
contract MockJPYC is ERC20 {
    address public immutable issuer;

    error NotIssuer();

    constructor(address issuer_) ERC20("Mock JPY Coin", "JPYC") {
        issuer = issuer_;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != issuer) revert NotIssuer();
        _mint(to, amount);
    }
}
