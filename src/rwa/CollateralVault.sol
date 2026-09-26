// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {CreditRiskModel} from "./CreditRiskModel.sol";

interface IOutstanding {
    function outstandingOf(address debtor) external view returns (uint256);
}

/// @title CollateralVault — debtors lock JPYC against what they owe, and earn interest on it
/// @notice
///   - Required at acceptance: before a debtor can accept an invoice it must hold collateral covering
///     `requiredBps[grade]` of everything it will then owe. Index 0 is for UNRATED debtors (default 20%); rated
///     grades G1–G5 default to 0% (operator-settable). Registration is never blocked, only acceptance.
///   - Locked until paid: collateral up to the debtor's accepted, unpaid face (`registry.outstandingOf`) can't be
///     withdrawn; only the excess can. So collateral that lowered a rate is still there if the debtor defaults.
///   - Any collateral lowers the debtor's rate (CreditRiskModel reads `coverageBps`): up to −2% at full coverage.
///   - Interest only on backing collateral: simple interest at `aprBps` on min(collateral, outstanding), so parking
///     JPYC without invoices earns nothing. Paid in JPYC from `rewardReserve`, a pool anyone (normally the operator)
///     funds; a claim pays what the pool can cover and the rest stays claimable.
///   - On default the registry seizes collateral up to the unpaid amount and adds it to what holders redeem. Interest
///     already accrued stays with the debtor.
///   Accounting: the vault's JPYC balance covers `totalCollateral + rewardReserve`; the two never mix.
contract CollateralVault is AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    uint256 public constant BPS = 10_000;
    uint256 public constant YEAR = 365 days;
    uint32 public constant MAX_APR = 2_000; // 20% p.a.

    IERC20 public immutable jpyc;
    CreditRiskModel public immutable risk;
    address public registry;
    uint32[6] public requiredBps; // collateral share required to accept, by grade; index 0 = unrated debtors
    mapping(address => uint256) public collateralOf;
    uint256 public totalCollateral;

    // Interest: a global index of interest earned per 1e18 of collateral, advanced at `aprBps` over time.
    uint32 public aprBps;
    uint256 public rewardReserve; // JPYC set aside to pay interest
    uint256 public interestIndex; // cumulative interest per 1e18 collateral (1e18 scale)
    uint64 public indexUpdatedAt;
    mapping(address => uint256) public indexOf; // debtor's snapshot of interestIndex
    mapping(address => uint256) public accruedInterest; // earned, not yet claimed
    mapping(address => uint256) public stakeOf; // collateral earning interest: min(collateral, outstanding)

    event RegistrySet(address registry);
    event RequiredBpsSet(uint8 indexed grade, uint32 bps);
    event CollateralDeposited(address indexed debtor, uint256 amount, uint256 total);
    event CollateralWithdrawn(address indexed debtor, uint256 amount, uint256 total);
    event CollateralSeized(address indexed debtor, uint256 indexed invoiceId, uint256 amount, uint256 remaining);
    event AprSet(uint32 bps);
    event RewardsFunded(address indexed from, uint256 amount, uint256 reserve);
    event RewardsWithdrawn(address indexed to, uint256 amount, uint256 reserve);
    event InterestClaimed(address indexed debtor, uint256 amount, uint256 stillOwed);

    error NotRegistry();
    error RegistryAlreadySet();
    error BadGrade();
    error BadApr(uint32 bps);
    error BelowRequired(uint256 required, uint256 remaining);
    error NothingToClaim(uint256 owed, uint256 reserve);
    error InsufficientReserve(uint256 reserve);

    constructor(IERC20 jpyc_, CreditRiskModel risk_, address admin) {
        jpyc = jpyc_;
        risk = risk_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(OPERATOR_ROLE, admin);
        requiredBps = [uint32(2_000), 0, 0, 0, 0, 0]; // unrated: 20% of what it will owe; rated: optional
        indexUpdatedAt = uint64(block.timestamp);
    }

    function setRegistry(address registry_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (registry != address(0)) revert RegistryAlreadySet();
        registry = registry_;
        emit RegistrySet(registry_);
    }

    function setRequiredBps(uint8 grade, uint32 bps) external onlyRole(OPERATOR_ROLE) {
        if (grade > 5 || bps > BPS) revert BadGrade(); // grade 0 = unrated
        requiredBps[grade] = bps;
        emit RequiredBpsSet(grade, bps);
    }

    // ---------------------------------------------------------------- interest (operator)
    /// @notice Set the APR paid on locked collateral. Interest up to now is booked at the old rate first.
    function setAprBps(uint32 bps) external onlyRole(OPERATOR_ROLE) {
        if (bps > MAX_APR) revert BadApr(bps);
        _updateIndex();
        aprBps = bps;
        emit AprSet(bps);
    }

    /// @notice Add JPYC to the pool that pays interest. Anyone may fund it.
    function fundRewards(uint256 amount) external {
        jpyc.safeTransferFrom(msg.sender, address(this), amount);
        rewardReserve += amount;
        emit RewardsFunded(msg.sender, amount, rewardReserve);
    }

    /// @notice Take unused JPYC back out of the interest pool (never touches collateral).
    function withdrawRewards(uint256 amount) external onlyRole(OPERATOR_ROLE) {
        if (amount > rewardReserve) revert InsufficientReserve(rewardReserve);
        rewardReserve -= amount;
        jpyc.safeTransfer(msg.sender, amount);
        emit RewardsWithdrawn(msg.sender, amount, rewardReserve);
    }

    // ---------------------------------------------------------------- debtor
    function deposit(uint256 amount) external {
        _accrue(msg.sender);
        jpyc.safeTransferFrom(msg.sender, address(this), amount);
        collateralOf[msg.sender] += amount;
        totalCollateral += amount;
        _restake(msg.sender);
        emit CollateralDeposited(msg.sender, amount, collateralOf[msg.sender]);
    }

    function withdraw(uint256 amount) external {
        _accrue(msg.sender);
        uint256 locked = lockedOf(msg.sender);
        uint256 remaining = collateralOf[msg.sender] - amount; // reverts on underflow
        if (remaining < locked) revert BelowRequired(locked, remaining);
        collateralOf[msg.sender] = remaining;
        totalCollateral -= amount;
        _restake(msg.sender);
        jpyc.safeTransfer(msg.sender, amount);
        emit CollateralWithdrawn(msg.sender, amount, remaining);
    }

    /// @notice Claim accrued interest, paid from the reward pool. Pays min(owed, pool); the rest stays claimable.
    function claimInterest() external returns (uint256 paid) {
        _accrue(msg.sender);
        uint256 owed = accruedInterest[msg.sender];
        paid = owed < rewardReserve ? owed : rewardReserve;
        if (paid == 0) revert NothingToClaim(owed, rewardReserve);
        accruedInterest[msg.sender] = owed - paid;
        rewardReserve -= paid;
        jpyc.safeTransfer(msg.sender, paid);
        emit InterestClaimed(msg.sender, paid, owed - paid);
    }

    // ---------------------------------------------------------------- registry
    /// @notice Move up to `max` of the debtor's collateral to the registry (invoice payout). Returns the amount.
    function seize(address debtor, uint256 invoiceId, uint256 max) external returns (uint256 amount) {
        if (msg.sender != registry) revert NotRegistry();
        _accrue(debtor);
        uint256 c = collateralOf[debtor];
        amount = c < max ? c : max;
        if (amount == 0) return 0;
        collateralOf[debtor] = c - amount;
        totalCollateral -= amount;
        _restake(debtor);
        jpyc.safeTransfer(registry, amount);
        emit CollateralSeized(debtor, invoiceId, amount, c - amount);
    }

    /// @notice Registry hook: the debtor's outstanding changed (accept, pay, default). Books interest on the old stake
    ///         and re-bases it.
    function sync(address debtor) external {
        if (msg.sender != registry) revert NotRegistry();
        _accrue(debtor);
        _restake(debtor);
    }

    // ---------------------------------------------------------------- views
    /// @notice Collateral that can't be withdrawn: whatever backs the debtor's accepted, unpaid invoices.
    function lockedOf(address debtor) public view returns (uint256) {
        if (registry == address(0)) return 0;
        uint256 c = collateralOf[debtor];
        uint256 outstanding = IOutstanding(registry).outstandingOf(debtor);
        return c < outstanding ? c : outstanding;
    }

    /// @notice Collateral share (bps) this debtor must cover to accept an invoice: by operator grade, 0 = unrated.
    function requiredBpsFor(address debtor) public view returns (uint256) {
        return requiredBps[risk.gradeOf(debtor)];
    }

    /// @notice Collateral the debtor must hold to accept an invoice of `extraFace`.
    function required(address debtor, uint256 extraFace) public view returns (uint256) {
        uint256 bps = requiredBpsFor(debtor);
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

    /// @notice Interest the debtor has earned and not yet claimed, up to now.
    function interestOf(address debtor) external view returns (uint256) {
        return accruedInterest[debtor] + stakeOf[debtor] * (_currentIndex() - indexOf[debtor]) / 1e18;
    }

    // ---------------------------------------------------------------- internal
    function _currentIndex() internal view returns (uint256) {
        return interestIndex + uint256(aprBps) * 1e18 * (block.timestamp - indexUpdatedAt) / (BPS * YEAR);
    }

    function _updateIndex() internal {
        interestIndex = _currentIndex();
        indexUpdatedAt = uint64(block.timestamp);
    }

    /// @dev Book the debtor's interest up to now on its current stake. Call before the stake changes.
    function _accrue(address debtor) internal {
        _updateIndex();
        accruedInterest[debtor] += stakeOf[debtor] * (interestIndex - indexOf[debtor]) / 1e18;
        indexOf[debtor] = interestIndex;
    }

    /// @dev Stake = collateral backing accepted invoices. Call right after collateral or outstanding changes.
    function _restake(address debtor) internal {
        stakeOf[debtor] = lockedOf(debtor);
    }
}
