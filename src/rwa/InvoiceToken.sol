// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IInvoiceRegistryPolicy {
    function canHold(address holder) external view returns (bool);
    function invoiceMetadata(uint256 id) external view returns (string memory);
}

/// @notice Fungible claim on one accepted invoice. 1 token (1e18 units) = ¥1 of face value, payable by the debtor
///         at maturity. Minted on debtor acceptance, burned on redemption. Only the registry can mint/burn.
///         Permissioned like an RWA security token: a transfer only succeeds if the registry says the recipient may
///         hold invoices (KYB-verified company, approved investor, or approved venue such as the Uniswap PoolManager).
contract InvoiceToken is ERC20 {
    address public immutable registry;
    uint256 public immutable invoiceId;

    error NotRegistry();
    error NotEligible(address holder);

    constructor(string memory name_, string memory symbol_, uint256 invoiceId_) ERC20(name_, symbol_) {
        registry = msg.sender;
        invoiceId = invoiceId_;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != registry) revert NotRegistry();
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        if (msg.sender != registry) revert NotRegistry();
        _burn(from, amount);
    }

    /// @notice ERC-7572 contract-level metadata: the invoice's details as on-chain JSON (live status and price).
    function contractURI() external view returns (string memory) {
        return string.concat("data:application/json;utf8,", IInvoiceRegistryPolicy(registry).invoiceMetadata(invoiceId));
    }

    function _update(address from, address to, uint256 value) internal override {
        // Mint (from 0) and burn (to 0) are registry-controlled; every transfer is checked against the holder policy.
        if (from != address(0) && to != address(0) && !IInvoiceRegistryPolicy(registry).canHold(to)) revert NotEligible(to);
        super._update(from, to, value);
    }
}
