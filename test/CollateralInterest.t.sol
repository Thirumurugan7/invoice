// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {TegataBase} from "./TegataBase.sol";
import {InvoiceRegistry} from "../src/rwa/InvoiceRegistry.sol";
import {CollateralVault} from "../src/rwa/CollateralVault.sol";

/// Collateral earns interest at an operator-set APR, paid in JPYC from a reward pool the operator funds, but only on
/// the part that backs accepted, unpaid invoices: min(collateral, outstanding). Parked JPYC earns nothing.
contract CollateralInterestTest is TegataBase {
    address company = makeAddr("New Co (unrated debtor)");
    uint256 constant OWED = 1_000_000e18;

    function setUp() public override {
        super.setUp();
        jpyc.mint(operator, 1_000_000e18);
        vm.startPrank(operator);
        jpyc.approve(address(vault), type(uint256).max);
        vault.fundRewards(100_000e18);
        vault.setAprBps(300); // 3% p.a.
        vm.stopPrank();
        jpyc.mint(company, 5_000_000e18);
        vm.startPrank(company);
        jpyc.approve(address(vault), type(uint256).max);
        jpyc.approve(address(registry), type(uint256).max);
        vm.stopPrank();
    }

    /// The company locks `collateral` and accepts a ¥1,000,000 invoice (unrated: needs ≥ 20%).
    function _backed(uint256 collateral) internal returns (uint256 id) {
        vm.prank(supplier);
        id = registry.registerInvoice(company, OWED, maturity, keccak256("backed"), "B-1");
        vm.startPrank(company);
        vault.deposit(collateral);
        registry.acceptInvoice(id);
        vm.stopPrank();
    }

    function _solvent() internal view {
        assertEq(jpyc.balanceOf(address(vault)), vault.totalCollateral() + vault.rewardReserve());
    }

    function test_interestAccruesAtApr() public {
        _backed(200_000e18);
        assertEq(vault.stakeOf(company), 200_000e18);
        vm.warp(block.timestamp + 365 days);
        assertEq(vault.interestOf(company), 6_000e18); // 3% of 200,000 for a year

        uint256 before = jpyc.balanceOf(company);
        vm.prank(company);
        assertEq(vault.claimInterest(), 6_000e18);
        assertEq(jpyc.balanceOf(company) - before, 6_000e18);
        assertEq(vault.interestOf(company), 0);
        assertEq(vault.rewardReserve(), 94_000e18);
        assertEq(vault.collateralOf(company), 200_000e18); // principal untouched
        _solvent();
    }

    function test_parkedCollateralEarnsNothing() public {
        vm.prank(company);
        vault.deposit(1_000_000e18); // no accepted invoices
        vm.warp(block.timestamp + 365 days);
        assertEq(vault.interestOf(company), 0);
    }

    function test_onlyTheBackingPartEarns() public {
        _backed(1_500_000e18); // ¥500,000 more than owed
        assertEq(vault.stakeOf(company), OWED);
        vm.warp(block.timestamp + 365 days);
        assertEq(vault.interestOf(company), 30_000e18); // 3% of the ¥1,000,000 backing, not ¥1,500,000
    }

    // Warps are absolute from a constant: with via_ir, block.timestamp read before a warp can be re-read after it.
    function test_stakeFollowsDepositsAndPayments() public {
        uint256 t0 = FRI_1000_JST; // the fixture's start time
        uint256 id = _backed(200_000e18);
        vm.warp(t0 + 365 days / 2);
        vm.prank(company);
        vault.deposit(200_000e18); // 200k for half a year, then 400k
        vm.warp(t0 + 365 days);
        // 200k × 3% × ½ + 400k × 3% × ½ = 3,000 + 6,000
        assertApproxEqAbs(vault.interestOf(company), 9_000e18, 1e6);
        vm.prank(company);
        registry.pay(id, OWED); // nothing owed any more: stake drops to 0
        assertEq(vault.stakeOf(company), 0);
        vm.warp(t0 + 2 * 365 days);
        assertApproxEqAbs(vault.interestOf(company), 9_000e18, 1e6); // no new interest
        vm.prank(company);
        vault.withdraw(400_000e18); // and all of it is free again
        _solvent();
    }

    function test_aprChangeOnlyAffectsTheFuture() public {
        uint256 t0 = FRI_1000_JST;
        _backed(200_000e18);
        vm.warp(t0 + 365 days);
        vm.prank(operator);
        vault.setAprBps(1_000); // 10% from now on
        vm.warp(t0 + 2 * 365 days);
        assertEq(vault.interestOf(company), 6_000e18 + 20_000e18);
    }

    function test_claimPaysWhatThePoolCoversAndKeepsTheRest() public {
        vm.prank(operator);
        vault.withdrawRewards(99_000e18); // pool down to 1,000
        _backed(200_000e18);
        vm.warp(block.timestamp + 365 days); // owed 6,000

        vm.prank(company);
        assertEq(vault.claimInterest(), 1_000e18);
        assertEq(vault.rewardReserve(), 0);
        assertEq(vault.interestOf(company), 5_000e18);

        vm.prank(company);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.NothingToClaim.selector, 5_000e18, 0));
        vault.claimInterest();

        vm.prank(operator);
        vault.fundRewards(10_000e18);
        vm.prank(company);
        assertEq(vault.claimInterest(), 5_000e18);
        _solvent();
    }

    function test_nothingToClaimWithoutCollateral() public {
        vm.prank(company);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.NothingToClaim.selector, 0, 100_000e18));
        vault.claimInterest();
    }

    function test_rewardPoolNeverPaysOutCollateral() public {
        _backed(200_000e18);
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
        vault.setRequiredBps(0, 0); // a debtor can't switch off its own requirement
        vm.stopPrank();
    }

    function test_aprIsCapped() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.BadApr.selector, 2_001));
        vault.setAprBps(2_001);
    }

    /// End to end: an unrated company locks 20%, accepts, earns interest, defaults. The seized collateral goes to
    /// holders; interest earned before the default stays claimable and comes from the pool, not the payout.
    function test_seizureKeepsInterestSeparate() public {
        vm.prank(company);
        vault.deposit(20_000e18); // 20% of ¥100,000 (unrated)
        vm.prank(supplier);
        uint256 id = registry.registerInvoice(company, 100_000e18, maturity, keccak256("NEW-1"), "NEW-1");
        vm.prank(company);
        registry.acceptInvoice(id);

        vm.warp(maturity + 3 days);
        registry.markDefault(id);
        assertEq(registry.invoice(id).funded, 20_000e18); // all collateral seized
        assertEq(vault.collateralOf(company), 0);
        assertEq(vault.stakeOf(company), 0);

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
