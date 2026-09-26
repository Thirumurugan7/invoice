// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {TegataBase} from "./TegataBase.sol";
import {InvoiceRegistry} from "../src/rwa/InvoiceRegistry.sol";
import {InvoiceToken} from "../src/rwa/InvoiceToken.sol";
import {CollateralVault} from "../src/rwa/CollateralVault.sol";

/// Debtor collateral: required for weak debtors (G4–G5), optional for strong ones, lowers the rate, and is seized
/// into the invoice payout on default.
contract CollateralTest is TegataBase {
    address weak = makeAddr("Weak Parts KK (G5 debtor)");
    address holder = makeAddr("approved holder");

    function setUp() public override {
        super.setUp();
        vm.startPrank(operator);
        registry.verifyCompany(weak, keccak256("corp:weak"), "Weak Parts KK");
        risk.rate(weak, 5); // 1% + 16% = 17%
        registry.approveInvestor(holder, true);
        vm.stopPrank();
        jpyc.mint(weak, 1_000_000e18);
        vm.prank(weak);
        jpyc.approve(address(vault), type(uint256).max);
        vm.prank(debtor);
        jpyc.approve(address(vault), type(uint256).max);
    }

    function _register(address d, uint256 face, string memory ref) internal returns (uint256) {
        vm.prank(supplier);
        return registry.registerInvoice(d, face, maturity, keccak256(bytes(ref)), ref);
    }

    function test_weakDebtorNeedsCollateralToBeInvoiced() public {
        vm.prank(supplier);
        vm.expectRevert(abi.encodeWithSelector(InvoiceRegistry.CollateralRequired.selector, weak, 20_000e18, 0));
        registry.registerInvoice(weak, 100_000e18, maturity, keccak256("w1"), "W-1");

        vm.prank(weak);
        vault.deposit(20_000e18); // 20% of ¥100,000
        uint256 id = _register(weak, 100_000e18, "W-1");
        assertEq(registry.outstandingOf(weak), 100_000e18);

        // A second ¥100,000 needs 20% of ¥200,000 in total.
        vm.prank(supplier);
        vm.expectRevert(abi.encodeWithSelector(InvoiceRegistry.CollateralRequired.selector, weak, 40_000e18, 20_000e18));
        registry.registerInvoice(weak, 100_000e18, maturity, keccak256("w2"), "W-2");
        assertGt(id, 0);
    }

    function test_strongDebtorNeedsNoCollateral() public {
        assertEq(vault.required(debtor, 10_000_000e18), 0); // G2
        _register(debtor, 10_000_000e18, "BIG-1");
    }

    function test_cannotWithdrawBelowRequirement() public {
        vm.prank(weak);
        vault.deposit(30_000e18);
        _register(weak, 100_000e18, "W-3"); // needs 20,000
        vm.startPrank(weak);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.BelowRequired.selector, 20_000e18, 15_000e18));
        vault.withdraw(15_000e18);
        vault.withdraw(10_000e18); // down to exactly 20,000: fine
        vm.stopPrank();
        assertEq(vault.collateralOf(weak), 20_000e18);
    }

    function test_paymentsReduceOutstandingAndRequirement() public {
        vm.prank(weak);
        vault.deposit(20_000e18);
        uint256 id = _register(weak, 100_000e18, "W-4");
        vm.prank(weak);
        registry.acceptInvoice(id);
        vm.startPrank(weak);
        jpyc.approve(address(registry), type(uint256).max);
        registry.pay(id, 50_000e18);
        vm.stopPrank();
        assertEq(registry.outstandingOf(weak), 50_000e18);
        assertEq(vault.required(weak, 0), 10_000e18);
    }

    function test_collateralLowersRate() public {
        assertEq(registry.rateOf(invoiceId), 300); // G2, no collateral
        vm.prank(debtor);
        vault.deposit(500_000e18); // 50% of the ¥1,000,000 outstanding -> −1%
        assertEq(registry.rateOf(invoiceId), 200);
        vm.prank(debtor);
        vault.deposit(500_000e18); // 100% -> −2%, floored at the 1% base rate
        assertEq(registry.rateOf(invoiceId), 100);
    }

    function test_defaultSeizesCollateralIntoPayout() public {
        vm.prank(weak);
        vault.deposit(20_000e18);
        uint256 id = _register(weak, 100_000e18, "W-5");
        vm.prank(weak);
        registry.acceptInvoice(id);
        InvoiceToken t = registry.invoice(id).token;
        vm.prank(supplier);
        t.transfer(holder, 100_000e18);

        vm.startPrank(weak); // pays only ¥30,000, then disappears
        jpyc.approve(address(registry), type(uint256).max);
        registry.pay(id, 30_000e18);
        vm.stopPrank();

        vm.warp(maturity + 3 days);
        registry.markDefault(id);
        assertEq(registry.invoice(id).funded, 50_000e18); // 30,000 paid + 20,000 seized
        assertEq(vault.collateralOf(weak), 0);
        assertEq(registry.outstandingOf(weak), 0);

        vm.prank(holder);
        uint256 got = registry.redeem(id, 100_000e18);
        emit log_named_decimal_uint("holder recovers (of 100,000)", got, 18);
        assertEq(got, 50_000e18); // 50% recovery instead of 30% without collateral
    }

    function test_onlyRegistrySeizes() public {
        vm.expectRevert(CollateralVault.NotRegistry.selector);
        vault.seize(weak, 1, 1);
    }
}
