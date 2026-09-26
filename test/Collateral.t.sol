// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {TegataBase} from "./TegataBase.sol";
import {InvoiceRegistry} from "../src/rwa/InvoiceRegistry.sol";
import {InvoiceToken} from "../src/rwa/InvoiceToken.sol";
import {CollateralVault} from "../src/rwa/CollateralVault.sol";

/// Debtor collateral: unrated debtors must lock 20% of what they will owe before they can ACCEPT an invoice
/// (registration is never blocked); rated grades are optional unless the operator sets a requirement. Collateral
/// backing accepted invoices is locked until paid, lowers the rate, and is seized into the payout on default.
contract CollateralTest is TegataBase {
    address weak = makeAddr("Unrated Parts KK");
    address holder = makeAddr("holder");

    function setUp() public override {
        super.setUp();
        jpyc.mint(weak, 1_000_000e18);
        vm.startPrank(weak);
        jpyc.approve(address(vault), type(uint256).max);
        jpyc.approve(address(registry), type(uint256).max);
        vm.stopPrank();
        vm.prank(debtor);
        jpyc.approve(address(vault), type(uint256).max);
    }

    function _register(address d, uint256 face, string memory ref) internal returns (uint256) {
        vm.prank(supplier);
        return registry.registerInvoice(d, face, maturity, keccak256(bytes(ref)), ref);
    }

    function test_unratedDebtorMustLockCollateralToAccept() public {
        uint256 id = _register(weak, 100_000e18, "W-1"); // registration is never blocked
        vm.prank(weak);
        vm.expectRevert(abi.encodeWithSelector(InvoiceRegistry.CollateralRequired.selector, weak, 20_000e18, 0));
        registry.acceptInvoice(id);

        vm.startPrank(weak);
        vault.deposit(20_000e18); // 20% of ¥100,000
        registry.acceptInvoice(id);
        vm.stopPrank();
        assertEq(registry.outstandingOf(weak), 100_000e18);

        // A second ¥100,000 needs 20% of ¥200,000 in total.
        uint256 id2 = _register(weak, 100_000e18, "W-2");
        vm.prank(weak);
        vm.expectRevert(abi.encodeWithSelector(InvoiceRegistry.CollateralRequired.selector, weak, 40_000e18, 20_000e18));
        registry.acceptInvoice(id2);
    }

    function test_ratedDebtorNeedsNoCollateralByDefault() public {
        assertEq(vault.required(debtor, 10_000_000e18), 0); // G2
        uint256 id = _register(debtor, 10_000_000e18, "BIG-1");
        vm.prank(debtor);
        registry.acceptInvoice(id);
    }

    function test_operatorCanRequireCollateralForARatedGrade() public {
        vm.startPrank(operator);
        risk.rate(weak, 5);
        vault.setRequiredBps(5, 1_000); // G5: 10%
        vault.setRequiredBps(0, 0); // unrated: optional
        vm.stopPrank();
        uint256 id = _register(weak, 100_000e18, "W-G5");
        vm.prank(weak);
        vm.expectRevert(abi.encodeWithSelector(InvoiceRegistry.CollateralRequired.selector, weak, 10_000e18, 0));
        registry.acceptInvoice(id);

        address fresh = makeAddr("unrated, requirement off");
        uint256 id2 = _register(fresh, 100_000e18, "FRESH-1");
        vm.prank(fresh);
        registry.acceptInvoice(id2); // unrated requirement set to 0
    }

    function test_collateralBackingAcceptedInvoicesIsLockedUntilPaid() public {
        vm.prank(weak);
        vault.deposit(30_000e18);
        uint256 id = _register(weak, 100_000e18, "W-3");
        vm.startPrank(weak);
        registry.acceptInvoice(id);
        assertEq(vault.lockedOf(weak), 30_000e18); // all of it backs the ¥100,000 owed
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.BelowRequired.selector, 30_000e18, 29_000e18));
        vault.withdraw(1_000e18);

        registry.pay(id, 80_000e18); // ¥20,000 still owed
        assertEq(vault.lockedOf(weak), 20_000e18);
        vault.withdraw(10_000e18); // the excess is free
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.BelowRequired.selector, 20_000e18, 19_999e18));
        vault.withdraw(1e18);
        registry.pay(id, 20_000e18);
        vault.withdraw(20_000e18); // fully paid: everything is free
        vm.stopPrank();
        assertEq(vault.collateralOf(weak), 0);
    }

    function test_excessCollateralCanBeWithdrawn() public {
        vm.prank(weak);
        vault.deposit(150_000e18);
        uint256 id = _register(weak, 100_000e18, "W-4");
        vm.startPrank(weak);
        registry.acceptInvoice(id);
        vault.withdraw(50_000e18); // 150,000 − 100,000 owed
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.BelowRequired.selector, 100_000e18, 99_999e18));
        vault.withdraw(1e18);
        vm.stopPrank();
    }

    function test_pendingInvoicesDoNotCountAsOutstanding() public {
        _register(weak, 100_000e18, "W-P");
        assertEq(registry.outstandingOf(weak), 0);
        assertEq(vault.required(weak, 0), 0);
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

        vm.prank(weak); // pays only ¥30,000, then disappears
        registry.pay(id, 30_000e18);

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

    function test_onlyRegistrySeizesOrSyncs() public {
        vm.expectRevert(CollateralVault.NotRegistry.selector);
        vault.seize(weak, 1, 1);
        vm.expectRevert(CollateralVault.NotRegistry.selector);
        vault.sync(weak);
    }
}
