// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {CreditRiskModel} from "./CreditRiskModel.sol";

interface IOutstanding {
    function outstandingOf(address debtor) external view returns (uint256);
}

/// @title CollateralVault — debtors lock JPYC against what they owe
/// @notice
///   - Weak debtors (grade G4–G5 by default) MUST cover a share of their outstanding invoices (20%) before a new
///     invoice can be registered against them. Strong debtors may post collateral voluntarily.
///   - Any collateral lowers the debtor's rate (CreditRiskModel reads `coverageBps`): up to −2% at full coverage.
///   - On default the registry seizes collateral up to the unpaid amount and adds it to what holders redeem.
///   - Collateral can be withdrawn only down to what the debtor's current outstanding requires.
contract CollateralVault is AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    uint256 public constant BPS = 10_000;

    IERC20 public immutable jpyc;
    CreditRiskModel public immutable risk;
    address public registry;
    uint32[6] public requiredBps; // by grade; index 0 = unrated
    mapping(address => uint256) public collateralOf;

    event RegistrySet(address registry);
    event RequiredBpsSet(uint8 indexed grade, uint32 bps);
    event CollateralDeposited(address indexed debtor, uint256 amount, uint256 total);
    event CollateralWithdrawn(address indexed debtor, uint256 amount, uint256 total);
    event CollateralSeized(address indexed debtor, uint256 indexed invoiceId, uint256 amount, uint256 remaining);

    error NotRegistry();
    error RegistryAlreadySet();
    error BadGrade();
    error BelowRequired(uint256 required, uint256 remaining);

    constructor(IERC20 jpyc_, CreditRiskModel risk_, address admin) {
        jpyc = jpyc_;
        risk = risk_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(OPERATOR_ROLE, admin);
        requiredBps = [uint32(0), 0, 0, 0, 2_000, 2_000]; // G4, G5: 20% of outstanding
    }

    function setRegistry(address registry_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (registry != address(0)) revert RegistryAlreadySet();
        registry = registry_;
        emit RegistrySet(registry_);
    }

    function setRequiredBps(uint8 grade, uint32 bps) external onlyRole(OPERATOR_ROLE) {
        if (grade == 0 || grade > 5 || bps > BPS) revert BadGrade();
        requiredBps[grade] = bps;
        emit RequiredBpsSet(grade, bps);
    }

    // ---------------------------------------------------------------- debtor
    function deposit(uint256 amount) external {
        jpyc.safeTransferFrom(msg.sender, address(this), amount);
        collateralOf[msg.sender] += amount;
        emit CollateralDeposited(msg.sender, amount, collateralOf[msg.sender]);
    }

    function withdraw(uint256 amount) external {
        uint256 need = required(msg.sender, 0);
        uint256 remaining = collateralOf[msg.sender] - amount; // reverts on underflow
        if (remaining < need) revert BelowRequired(need, remaining);
        collateralOf[msg.sender] = remaining;
        jpyc.safeTransfer(msg.sender, amount);
        emit CollateralWithdrawn(msg.sender, amount, remaining);
    }

    // ---------------------------------------------------------------- registry
    /// @notice Move up to `max` of the debtor's collateral to the registry (invoice payout). Returns the amount.
    function seize(address debtor, uint256 invoiceId, uint256 max) external returns (uint256 amount) {
        if (msg.sender != registry) revert NotRegistry();
        uint256 c = collateralOf[debtor];
        amount = c < max ? c : max;
        if (amount == 0) return 0;
        collateralOf[debtor] = c - amount;
        jpyc.safeTransfer(registry, amount);
        emit CollateralSeized(debtor, invoiceId, amount, c - amount);
    }

    // ---------------------------------------------------------------- views
    /// @notice Collateral the debtor must hold if its outstanding grew by `extraFace`.
    function required(address debtor, uint256 extraFace) public view returns (uint256) {
        uint256 bps = requiredBps[risk.gradeOf(debtor)];
        if (bps == 0) return 0;
        uint256 outstanding = IOutstanding(registry).outstandingOf(debtor) + extraFace;
        return (outstanding * bps + BPS - 1) / BPS; // round up
    }

    /// @notice Collateral / outstanding, capped at 100% (bps). Posting collateral with nothing outstanding = 100%.
    function coverageBps(address debtor) external view returns (uint256) {
        uint256 c = collateralOf[debtor];
        if (c == 0 || registry == address(0)) return 0;
        uint256 outstanding = IOutstanding(registry).outstandingOf(debtor);
        if (outstanding == 0) return BPS;
        uint256 cov = c * BPS / outstanding;
        return cov > BPS ? BPS : cov;
    }
}
