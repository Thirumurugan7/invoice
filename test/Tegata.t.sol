// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TegataBase} from "./TegataBase.sol";
import {InvoiceRegistry} from "../src/rwa/InvoiceRegistry.sol";
import {InvoiceToken} from "../src/rwa/InvoiceToken.sol";
import {MaturityCurveHook} from "../src/hook/MaturityCurveHook.sol";

contract TegataTest is TegataBase {
    // ================================================================ RWA lifecycle (Curvegrid side)

    function test_acceptMintsFaceToSupplier() public view {
        InvoiceRegistry.Invoice memory inv = registry.invoice(invoiceId);
        assertEq(uint8(inv.status), uint8(InvoiceRegistry.Status.Accepted));
        assertEq(token.balanceOf(supplier), FACE);
        assertEq(token.totalSupply(), FACE);
        assertEq(registry.idOfToken(address(token)), invoiceId);
    }

    function test_anyCompanyCanRegisterAndAccept() public {
        address newSupplier = makeAddr("new supplier (no KYB)");
        vm.prank(newSupplier);
        uint256 id2 = registry.registerInvoice(debtor, 5_000e18, maturity, keccak256("x"), "NEW-1");
        vm.prank(debtor);
        registry.acceptInvoice(id2);
        assertEq(registry.invoice(id2).token.balanceOf(newSupplier), 5_000e18);
    }

    function test_invalidDebtorRejected() public {
        vm.startPrank(supplier);
        vm.expectRevert(InvoiceRegistry.InvalidTerms.selector);
        registry.registerInvoice(address(0), FACE, maturity, keccak256("y0"), "");
        vm.expectRevert(InvoiceRegistry.InvalidTerms.selector);
        registry.registerInvoice(supplier, FACE, maturity, keccak256("y1"), "");
        vm.stopPrank();
    }

    function test_sameInvoiceCannotBeFinancedTwice() public {
        vm.prank(supplier);
        vm.expectRevert(abi.encodeWithSelector(InvoiceRegistry.DuplicateInvoice.selector, invoiceId));
        registry.registerInvoice(debtor, FACE, maturity, DOC, ""); // 二重譲渡 blocked
    }

    function test_onlyDebtorAcceptsAndCanReject() public {
        vm.prank(supplier);
        uint256 id2 = registry.registerInvoice(debtor, 5_000e18, maturity, keccak256("inv-2"), "");
        vm.prank(supplier);
        vm.expectRevert(InvoiceRegistry.NotDebtor.selector);
        registry.acceptInvoice(id2);
        vm.prank(debtor);
        registry.rejectInvoice(id2, "goods not delivered");
        assertEq(uint8(registry.invoice(id2).status), uint8(InvoiceRegistry.Status.Rejected));
        assertEq(registry.invoice(id2).token.totalSupply(), 0);
    }

    function test_fairPriceAccretesToFace() public {
        uint256 p0 = registry.fairPrice(invoiceId, block.timestamp);
        // 1 / (1 + 3% * 90/365) = 0.99266...
        assertApproxEqRel(p0, 0.992660e18, 1e14);
        uint256 p60 = registry.fairPrice(invoiceId, block.timestamp + 60 days);
        assertGt(p60, p0);
        assertEq(registry.fairPrice(invoiceId, maturity), 1e18);
    }

    function test_debtorPaysAtMaturityHoldersRedeem1to1() public {
        _sellInvoice(supplier, 300_000e18);
        vm.warp(maturity);
        vm.startPrank(debtor);
        jpyc.approve(address(registry), FACE);
        registry.pay(invoiceId, FACE);
        vm.stopPrank();
        assertEq(uint8(registry.invoice(invoiceId).status), uint8(InvoiceRegistry.Status.Settled));

        uint256 before = jpyc.balanceOf(supplier);
        vm.prank(supplier);
        uint256 paid = registry.redeem(invoiceId, 700_000e18);
        assertEq(paid, 700_000e18);
        assertEq(jpyc.balanceOf(supplier) - before, 700_000e18);
        assertEq(token.balanceOf(supplier), 0);
    }

    function test_partialPaymentThenDefaultRedeemsProRata() public {
        vm.startPrank(debtor);
        jpyc.approve(address(registry), FACE);
        registry.pay(invoiceId, 400_000e18);
        vm.stopPrank();

        vm.warp(maturity + 1 days);
        vm.expectRevert(abi.encodeWithSelector(InvoiceRegistry.NotYetDefaultable.selector, uint256(maturity) + 3 days));
        registry.markDefault(invoiceId);

        vm.warp(maturity + 3 days);
        registry.markDefault(invoiceId);
        vm.prank(supplier);
        uint256 paid = registry.redeem(invoiceId, 100_000e18);
        assertEq(paid, 40_000e18); // 40% recovery
    }

    function test_cannotRedeemBeforeSettlement() public {
        vm.prank(supplier);
        vm.expectRevert(abi.encodeWithSelector(InvoiceRegistry.BadStatus.selector, InvoiceRegistry.Status.Accepted));
        registry.redeem(invoiceId, 1e18);
    }

    // ================================================================ Uniswap hook side

    function test_supplierGetsEarlyCashNearCurve() public {
        uint256 before = jpyc.balanceOf(supplier);
        _sellInvoice(supplier, 300_000e18);
        uint256 cash = jpyc.balanceOf(supplier) - before;
        uint256 fairValue = 300_000e18 * registry.fairPrice(invoiceId, block.timestamp) / 1e18;
        // Paid within the curve band (fee + walking the bid ladder), never a predatory discount.
        assertGt(cash, fairValue * 98 / 100);
        assertLt(cash, fairValue);
        emit log_named_decimal_uint("supplier early cash for 300k face (JPYC)", cash, 18);
        emit log_named_decimal_uint("fair value on curve (JPYC)", fairValue, 18);
    }

    function test_dumpBeyondBandReverts() public {
        // Selling far more than the bid ladder would crash the price off the curve.
        vm.expectRevert();
        _sellInvoice(supplier, 900_000e18);
    }

    function test_poolForUnacceptedInvoiceCannotInit() public {
        vm.prank(supplier);
        uint256 id2 = registry.registerInvoice(debtor, 5_000e18, maturity, keccak256("inv-pending"), "");
        InvoiceToken t2 = registry.invoice(id2).token;
        PoolKey memory k2 = _keyFor(address(t2));
        vm.expectRevert(
            _hookRevert(IHooks.beforeInitialize.selector, abi.encodeWithSelector(MaturityCurveHook.InvoiceNotAccepted.selector, id2))
        );
        manager.initialize(k2, TickMath.getSqrtPriceAtTick(0));
    }

    function test_poolMustStartOnCurve() public {
        address weak = makeAddr("weak debtor");
        vm.prank(operator);
        risk.rate(weak, 5); // 1% + 16% = 17%
        jpyc.mint(weak, 1_000e18);
        vm.startPrank(weak); // G5 must lock 20% of what it will owe before being invoiced
        jpyc.approve(address(vault), 1_000e18);
        vault.deposit(1_000e18);
        vm.stopPrank();
        vm.prank(supplier);
        uint256 id2 = registry.registerInvoice(weak, 5_000e18, maturity, keccak256("inv-offcurve"), "");
        vm.prank(weak);
        registry.acceptInvoice(id2);
        PoolKey memory k2 = _keyFor(address(registry.invoice(id2).token));
        vm.expectRevert(); // InitOffCurve: price 1.0 vs fair ~0.960
        manager.initialize(k2, TickMath.getSqrtPriceAtTick(0));
    }

    function test_nonInvoicePoolCannotUseHook() public {
        address random = address(new InvoiceToken("x", "x", 0));
        PoolKey memory k = _keyFor(random);
        vm.expectRevert(_hookRevert(IHooks.beforeInitialize.selector, abi.encodeWithSelector(MaturityCurveHook.NotInvoicePool.selector)));
        manager.initialize(k, TickMath.getSqrtPriceAtTick(0));
    }

    function test_tradingClosesDayBeforeMaturity() public {
        vm.warp(maturity - 12 hours);
        vm.expectRevert(
            _hookRevert(IHooks.beforeSwap.selector, abi.encodeWithSelector(MaturityCurveHook.TradingClosed.selector, invoiceId))
        );
        _sellInvoice(supplier, 1_000e18);
    }

    function test_frozenInvoiceHaltsTrading() public {
        vm.prank(operator);
        registry.setFrozen(invoiceId, true);
        vm.expectRevert(
            _hookRevert(IHooks.beforeSwap.selector, abi.encodeWithSelector(MaturityCurveHook.TradingClosed.selector, invoiceId))
        );
        _sellInvoice(supplier, 1_000e18);
    }

    function test_driftedPoolOnlyAcceptsSwapsTowardCurve() public {
        _sellInvoice(supplier, 200_000e18); // pool now holds invoice tokens, price a bit below the curve
        vm.prank(operator);
        hook.setBandBps(20); // tighten band to 0.2% so accretion drift puts the pool outside it
        vm.warp(block.timestamp + 45 days); // curve accretes; pool price is now stale / below the curve

        // Selling pushes further below the curve -> rejected.
        vm.expectRevert();
        _sellInvoice(supplier, 1_000e18);

        // Buying moves the price up toward the curve -> allowed even while outside the band.
        _buyInvoice(investor, 1_000e18);
    }

    function test_curveTradeEventCarriesFairValue() public {
        vm.recordLogs();
        _sellInvoice(supplier, 10_000e18);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(hook) && logs[i].topics[0] == MaturityCurveHook.CurveTrade.selector) {
                (uint256 price, uint256 fair, uint256 dev) = abi.decode(logs[i].data, (uint256, uint256, uint256));
                assertEq(uint256(logs[i].topics[1]), invoiceId);
                assertEq(fair, registry.fairPrice(invoiceId, block.timestamp));
                assertLe(dev, hook.bandBps());
                assertGt(price, 0);
                found = true;
            }
        }
        assertTrue(found, "CurveTrade not emitted");
    }
}
