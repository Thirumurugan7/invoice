// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

interface ICollateralCoverage {
    function coverageBps(address debtor) external view returns (uint256);
}

/// @title CreditRiskModel — the debtor's discount rate, priced from rating + on-chain payment history
/// @notice The supplier does not choose the rate. Every invoice's fair-value curve uses the DEBTOR's live rate:
///
///   rate(debtor) = baseRate                                    (operator: funding cost, e.g. TONA + margin)
///                + gradeSpread[grade(debtor)]                  (operator: KYB / credit bureau grade, 1 = best)
///                + defaults  × DEFAULT_PENALTY                 (registry: each invoice the debtor defaulted on)
///                + latePays  × LATE_PENALTY                    (registry: settled after maturity, before default)
///                − min(onTime, ON_TIME_CAP) × ON_TIME_CREDIT   (registry: settled on or before maturity)
///                − coverage × COLLATERAL_CREDIT                 (CollateralVault: JPYC locked vs outstanding)
///
///   clamped to [baseRate, MAX_RATE]. A downgrade or a default therefore reprices every open invoice of that debtor
///   at once: the hook's band follows the new curve, so buying above it is blocked and holders can only exit toward it.
///   Grade 0 = unrated: the registry refuses invoices against an unrated debtor.
contract CreditRiskModel is AccessControl {
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    uint8 public constant MAX_GRADE = 5;
    uint32 public constant MAX_RATE = 5_000; // 50% p.a.
    uint32 public constant DEFAULT_PENALTY = 1_000;
    uint32 public constant LATE_PENALTY = 100;
    uint32 public constant ON_TIME_CREDIT = 10;
    uint32 public constant ON_TIME_CAP = 10;
    uint32 public constant COLLATERAL_CREDIT = 200; // −2% at 100% collateral coverage

    struct History {
        uint32 onTime;
        uint32 late;
        uint32 defaults;
    }

    address public registry;
    ICollateralCoverage public vault;
    uint32 public baseRateBps;
    uint32[MAX_GRADE + 1] public gradeSpreadBps; // index 0 unused (unrated)
    mapping(address => uint8) public gradeOf;
    mapping(address => History) public historyOf;

    enum CreditEvent {
        OnTime,
        Late,
        Default
    }

    event RegistrySet(address registry);
    event VaultSet(address vault);
    event BaseRateSet(uint32 bps);
    event GradeSpreadSet(uint8 indexed grade, uint32 bps);
    event DebtorRated(address indexed debtor, uint8 grade, uint32 rateBps);
    event CreditEventRecorded(address indexed debtor, CreditEvent kind, uint256 indexed invoiceId, uint32 rateBps);

    error NotRegistry();
    error BadGrade();
    error RegistryAlreadySet();

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(OPERATOR_ROLE, admin);
        baseRateBps = 100; // 1.00%
        gradeSpreadBps = [uint32(0), 100, 200, 400, 800, 1_600]; // grade 1 (prime) .. 5 (weak)
    }

    /// @notice One-time wiring: only the registry can record settlements and defaults.
    function setRegistry(address registry_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (registry != address(0)) revert RegistryAlreadySet();
        registry = registry_;
        emit RegistrySet(registry_);
    }

    /// @notice One-time wiring: collateral coverage lowers the debtor's rate.
    function setVault(address vault_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (address(vault) != address(0)) revert RegistryAlreadySet();
        vault = ICollateralCoverage(vault_);
        emit VaultSet(vault_);
    }

    // ---------------------------------------------------------------- operator (MultiBaas)
    function setBaseRate(uint32 bps) external onlyRole(OPERATOR_ROLE) {
        baseRateBps = bps;
        emit BaseRateSet(bps);
    }

    function setGradeSpread(uint8 grade, uint32 bps) external onlyRole(OPERATOR_ROLE) {
        if (grade == 0 || grade > MAX_GRADE) revert BadGrade();
        gradeSpreadBps[grade] = bps;
        emit GradeSpreadSet(grade, bps);
    }

    /// @notice Rate a debtor (1 = prime .. 5 = weak). Re-rating reprices all of the debtor's open invoices.
    function rate(address debtor, uint8 grade) external onlyRole(OPERATOR_ROLE) {
        if (grade == 0 || grade > MAX_GRADE) revert BadGrade();
        gradeOf[debtor] = grade;
        emit DebtorRated(debtor, grade, rateBps(debtor));
    }

    // ---------------------------------------------------------------- registry
    function record(address debtor, CreditEvent kind, uint256 invoiceId) external {
        if (msg.sender != registry) revert NotRegistry();
        History storage h = historyOf[debtor];
        if (kind == CreditEvent.OnTime) h.onTime++;
        else if (kind == CreditEvent.Late) h.late++;
        else h.defaults++;
        emit CreditEventRecorded(debtor, kind, invoiceId, rateBps(debtor));
    }

    // ---------------------------------------------------------------- views
    function isRated(address debtor) external view returns (bool) {
        return gradeOf[debtor] != 0;
    }

    /// @notice Annual simple discount rate (bps) for invoices owed by `debtor`, right now.
    function rateBps(address debtor) public view returns (uint32) {
        History memory h = historyOf[debtor];
        uint256 up = uint256(baseRateBps) + gradeSpreadBps[gradeOf[debtor]] + uint256(h.defaults) * DEFAULT_PENALTY
            + uint256(h.late) * LATE_PENALTY;
        uint256 credit = uint256(h.onTime < ON_TIME_CAP ? h.onTime : ON_TIME_CAP) * ON_TIME_CREDIT;
        if (address(vault) != address(0)) credit += vault.coverageBps(debtor) * COLLATERAL_CREDIT / 10_000;
        uint256 r = up > credit ? up - credit : 0;
        if (r < baseRateBps) r = baseRateBps;
        return uint32(r > MAX_RATE ? MAX_RATE : r);
    }
}
