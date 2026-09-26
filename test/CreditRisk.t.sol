// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {TegataBase} from "./TegataBase.sol";
import {InvoiceRegistry} from "../src/rwa/InvoiceRegistry.sol";
import {CreditRiskModel} from "../src/rwa/CreditRiskModel.sol";

/// The curve is priced from the DEBTOR's credit, not chosen by the supplier: rating + on-chain payment history.
contract CreditRiskTest is TegataBase {
    uint256 constant YEAR = 365 days;

    function _fairAt(uint256 rateBps, uint256 remaining) internal pure returns (uint256) {
        return 1e18 * YEAR * 10_000 / (YEAR * 10_000 + rateBps * remaining);
    }

    function _smallInvoice(uint64 mat, bytes32 doc) internal returns (uint256 id) {
        vm.prank(supplier);
        id = registry.registerInvoice(debtor, 5_000e18, mat, doc, "");
        vm.prank(debtor);
        registry.acceptInvoice(id);
    }

    function test_rateComesFromDebtorNotSupplier() public view {
        assertEq(risk.rateBps(debtor), 300);
        assertEq(registry.invoice(invoiceId).rateAtIssueBps, 300);
        assertEq(registry.rateOf(invoiceId), 300);
        assertEq(registry.fairPrice(invoiceId, block.timestamp), _fairAt(300, 90 days));
    }

    /// An unrated debtor is priced as the weakest grade (G5: 1% + 16% = 17%) and must lock 20% collateral first.
    function test_unratedDebtorPricedAsG5AndNeedsCollateral() public {
        address unrated = makeAddr("unrated");
        assertFalse(risk.isRated(unrated));
        assertEq(risk.gradeOf(unrated), 0);
        assertEq(risk.gradeFor(unrated), 5);
        assertEq(risk.rateBps(unrated), 1_700);

        vm.prank(supplier);
        vm.expectRevert(abi.encodeWithSelector(InvoiceRegistry.CollateralRequired.selector, unrated, 200_000e18, 0));
        registry.registerInvoice(unrated, FACE, maturity, keccak256("z"), "");

        jpyc.mint(unrated, 200_000e18);
        vm.startPrank(unrated);
        jpyc.approve(address(vault), type(uint256).max);
        vault.deposit(200_000e18);
        vm.stopPrank();
        vm.prank(supplier);
        uint256 id = registry.registerInvoice(unrated, FACE, maturity, keccak256("z"), "");
        // 17% − 20% coverage × 2% = 16.6%
        assertEq(registry.invoice(id).rateAtIssueBps, 1_660);

        // Once the operator rates it, the grade (and price) follow the rating.
        vm.prank(operator);
        risk.rate(unrated, 1);
        assertEq(risk.gradeFor(unrated), 1);
        assertEq(registry.rateOf(id), 160); // 1% + 1% − 0.4%
    }

    /// The deploy default: collateral optional (G4–G5 requirement 0). An unrated debtor can be invoiced at once; the
    /// risk is priced by the G5 rate, and collateral stays voluntary (it lowers the rate and can be withdrawn freely).
    function test_unratedDebtorInvoicedWithoutCollateralWhenOptional() public {
        vm.startPrank(operator);
        vault.setRequiredBps(4, 0);
        vault.setRequiredBps(5, 0);
        vm.stopPrank();
        address unrated = makeAddr("unrated, no collateral");
        assertEq(vault.required(unrated, FACE), 0);

        vm.prank(supplier);
        uint256 id = registry.registerInvoice(unrated, FACE, maturity, keccak256("no-collateral"), "NC-1");
        assertEq(registry.invoice(id).rateAtIssueBps, 1_700); // G5, nothing locked
        vm.prank(unrated);
        registry.acceptInvoice(id);
        assertEq(registry.invoice(id).token.balanceOf(supplier), FACE);

        // Voluntary collateral still lowers the rate and can be taken back at any time.
        jpyc.mint(unrated, 500_000e18);
        vm.startPrank(unrated);
        jpyc.approve(address(vault), type(uint256).max);
        vault.deposit(500_000e18); // 50% coverage -> −1%
        assertEq(registry.rateOf(id), 1_600);
        vault.withdraw(500_000e18);
        vm.stopPrank();
        assertEq(registry.rateOf(id), 1_700);
    }

    function test_onlyRegistryRecordsHistory() public {
        vm.expectRevert(CreditRiskModel.NotRegistry.selector);
        risk.record(debtor, CreditRiskModel.CreditEvent.OnTime, 1);
    }

    function test_downgradeRepricesPoolBuysBlockedSellsAllowed() public {
        uint256 before = registry.fairPrice(invoiceId, block.timestamp);
        vm.prank(operator);
        risk.rate(debtor, 5); // 1% + 16% = 17%
        uint256 afterFair = registry.fairPrice(invoiceId, block.timestamp);
        emit log_named_decimal_uint("fair before downgrade", before, 18);
        emit log_named_decimal_uint("fair after downgrade ", afterFair, 18);
        assertEq(afterFair, _fairAt(1_700, 90 days));

        // The pool still sits on the old (higher) curve: buying pushes further above the new curve -> blocked.
        vm.expectRevert();
        _buyInvoice(investor, 1_000e18);
        // Selling moves the price down toward the repriced curve -> allowed.
        _sellInvoice(supplier, 10_000e18);
    }

    function test_defaultRepricesEveryOpenInvoiceOfDebtor() public {
        uint256 id2 = _smallInvoice(uint64(block.timestamp + 10 days), keccak256("short"));
        vm.warp(block.timestamp + 13 days + 1);
        registry.markDefault(id2);
        (,, uint32 defaults) = risk.historyOf(debtor);
        assertEq(defaults, 1);
        assertEq(registry.rateOf(invoiceId), 1_300); // 300 + 1000 default penalty
        assertEq(registry.fairPrice(invoiceId, block.timestamp), _fairAt(1_300, maturity - block.timestamp));
    }

    function test_onTimeSettlementLowersRate() public {
        uint256 id2 = _smallInvoice(uint64(block.timestamp + 10 days), keccak256("ontime"));
        vm.startPrank(debtor);
        jpyc.approve(address(registry), 5_000e18);
        registry.pay(id2, 5_000e18);
        vm.stopPrank();
        assertEq(registry.rateOf(invoiceId), 290);
    }

    function test_latePaymentRaisesRate() public {
        uint256 id2 = _smallInvoice(uint64(block.timestamp + 10 days), keccak256("late"));
        vm.warp(block.timestamp + 11 days);
        vm.startPrank(debtor);
        jpyc.approve(address(registry), 5_000e18);
        registry.pay(id2, 5_000e18);
        vm.stopPrank();
        assertEq(registry.rateOf(invoiceId), 400);
    }

    function test_rateIsClamped() public {
        vm.startPrank(operator);
        risk.setBaseRate(4_000);
        risk.rate(debtor, 5);
        vm.stopPrank();
        assertEq(risk.rateBps(debtor), 5_000);
    }
}
