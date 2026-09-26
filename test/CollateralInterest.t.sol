// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {TegataBase} from "./TegataBase.sol";
import {InvoiceRegistry} from "../src/rwa/InvoiceRegistry.sol";
import {CollateralVault} from "../src/rwa/CollateralVault.sol";

/// Locked collateral earns interest at an operator-set APR, paid in JPYC from a reward pool the operator funds.
contract CollateralInterestTest is TegataBase {
    address company = makeAddr("New Co (unrated debtor)");

    function setUp() public override {
        super.setUp();
        jpyc.mint(operator, 1_000_000e18);
        vm.startPrank(operator);
        jpyc.approve(address(vault), type(uint256).max);
        vault.fundRewards(100_000e18);
        vault.setAprBps(300); // 3% p.a.
        vm.stopPrank();
        jpyc.mint(company, 1_000_000e18);
        vm.prank(company);
        jpyc.approve(address(vault), type(uint256).max);
    }

    function _solvent() internal view {
        assertGe(jpyc.balanceOf(address(vault)), vault.totalCollateral() + vault.rewardReserve());
    }

    function test_interestAccruesAtApr() public {
        vm.prank(company);
        vault.deposit(100_000e18);
        vm.warp(block.timestamp + 365 days);
        assertEq(vault.interestOf(company), 3_000e18); // 3% of 100,000 for a year

        uint256 before = jpyc.balanceOf(company);
        vm.prank(company);
        uint256 paid = vault.claimInterest();
        assertEq(paid, 3_000e18);
        assertEq(jpyc.balanceOf(company) - before, 3_000e18);
        assertEq(vault.interestOf(company), 0);
        assertEq(vault.rewardReserve(), 97_000e18);
        assertEq(vault.collateralOf(company), 100_000e18); // principal untouched
        _solvent();
    }

    // Warps are absolute from a constant: with via_ir, block.timestamp read before a warp can be re-read after it.
    function test_depositsAndWithdrawalsAccrueOnTheRightBalance() public {
        uint256 t0 = FRI_1000_JST; // the fixture's start time
        vm.prank(company);
        vault.deposit(100_000e18);
        vm.warp(t0 + 365 days / 2);
        vm.prank(company);
        vault.deposit(100_000e18); // 100k for half a year, then 200k
        vm.warp(t0 + 365 days);
        // 100k × 3% × ½ + 200k × 3% × ½ = 1,500 + 3,000
        assertApproxEqAbs(vault.interestOf(company), 4_500e18, 1e6);
        vm.prank(company);
        vault.withdraw(200_000e18); // withdrawing books interest first; nothing is lost
        assertApproxEqAbs(vault.interestOf(company), 4_500e18, 1e6);
        vm.warp(t0 + 2 * 365 days);
        assertApproxEqAbs(vault.interestOf(company), 4_500e18, 1e6); // no collateral, no new interest
        _solvent();
    }

    function test_aprChangeOnlyAffectsTheFuture() public {
        uint256 t0 = FRI_1000_JST; // the fixture's start time
        vm.prank(company);
        vault.deposit(100_000e18);
        vm.warp(t0 + 365 days);
        vm.prank(operator);
        vault.setAprBps(1_000); // 10% from now on
        vm.warp(t0 + 2 * 365 days);
        assertEq(vault.interestOf(company), 3_000e18 + 10_000e18);
    }

    function test_claimPaysWhatThePoolCoversAndKeepsTheRest() public {
        vm.prank(operator);
        vault.withdrawRewards(99_000e18); // pool down to 1,000
        vm.prank(company);
        vault.deposit(100_000e18);
        vm.warp(block.timestamp + 365 days); // owed 3,000

        vm.prank(company);
        assertEq(vault.claimInterest(), 1_000e18);
        assertEq(vault.rewardReserve(), 0);
        assertEq(vault.interestOf(company), 2_000e18);

        vm.prank(company);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.NothingToClaim.selector, 2_000e18, 0));
        vault.claimInterest();

        vm.prank(operator);
        vault.fundRewards(5_000e18);
        vm.prank(company);
        assertEq(vault.claimInterest(), 2_000e18);
        _solvent();
    }

    function test_nothingToClaimWithoutCollateral() public {
        vm.prank(company);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.NothingToClaim.selector, 0, 100_000e18));
        vault.claimInterest();
    }

    function test_rewardPoolNeverPaysOutCollateral() public {
        vm.prank(company);
        vault.deposit(100_000e18);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.InsufficientReserve.selector, 100_000e18));
        vault.withdrawRewards(100_001e18);
    }

    function test_onlyOperatorSetsAprRequirementAndWithdrawsRewards() public {
        bytes32 role = vault.OPERATOR_ROLE();
        vm.startPrank(company);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, company, role));
        vault.setAprBps(1_000);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, company, role));
        vault.withdrawRewards(1);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, company, role));
        vault.setRequiredBps(5, 0); // a debtor can't switch off a requirement the operator set
        vm.stopPrank();
    }

    function test_aprIsCapped() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.BadApr.selector, 2_001));
        vault.setAprBps(2_001);
    }

    /// End to end: an unrated company locks collateral, gets invoiced, earns interest, defaults. The seized collateral
    /// goes to holders; interest earned before the default stays claimable and comes from the pool, not the payout.
    function test_seizureKeepsInterestSeparate() public {
        vm.prank(company);
        vault.deposit(20_000e18); // 20% of ¥100,000 (unrated = G5)
        vm.prank(supplier);
        uint256 id = registry.registerInvoice(company, 100_000e18, maturity, keccak256("NEW-1"), "NEW-1");
        vm.prank(company);
        registry.acceptInvoice(id);

        vm.warp(maturity + 3 days);
        registry.markDefault(id);
        assertEq(registry.invoice(id).funded, 20_000e18); // all collateral seized
        assertEq(vault.collateralOf(company), 0);

        uint256 owed = vault.interestOf(company); // 20,000 × 3% × 93 days
        uint256 expected = uint256(20_000e18) * 300 * 93 days / (10_000 * 365 days);
        assertApproxEqAbs(owed, expected, 1e6);
        vm.prank(company);
        assertEq(vault.claimInterest(), owed);

        vm.prank(supplier);
        assertEq(registry.redeem(id, 100_000e18), 20_000e18); // holders get the seized collateral in full
        _solvent();
    }
}
