// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";

import {InvoiceRegistry} from "../src/rwa/InvoiceRegistry.sol";
import {InvoiceToken} from "../src/rwa/InvoiceToken.sol";
import {CreditRiskModel} from "../src/rwa/CreditRiskModel.sol";
import {CollateralVault} from "../src/rwa/CollateralVault.sol";
import {MockJPYC} from "../src/rwa/MockJPYC.sol";
import {MaturityCurveHook} from "../src/hook/MaturityCurveHook.sol";
import {TegataMarket} from "../src/periphery/TegataMarket.sol";

/// Each test pins down one statement made to judges, through the same TegataMarket path the web app uses.
contract ClaimsTest is Test {
    uint160 constant FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG;

    address operator = makeAddr("operator");
    address supplier = makeAddr("supplier");
    address debtor = makeAddr("debtor");
    address investor = makeAddr("approved investor");
    address anon = makeAddr("anonymous wallet");

    MockJPYC jpyc;
    CreditRiskModel risk;
    InvoiceRegistry registry;
    TegataMarket market;

    function setUp() public {
        vm.warp(1_790_298_000);
        IPoolManager manager = new PoolManager(address(this));
        jpyc = new MockJPYC(address(this));
        risk = new CreditRiskModel(operator);
        CollateralVault vault = new CollateralVault(jpyc, risk, operator);
        registry = new InvoiceRegistry(jpyc, risk, vault, operator);
        bytes memory args = abi.encode(manager, registry, Currency.wrap(address(jpyc)), operator);
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(MaturityCurveHook).creationCode, args);
        MaturityCurveHook hook = new MaturityCurveHook{salt: salt}(manager, registry, Currency.wrap(address(jpyc)), operator);
        market = new TegataMarket(manager, registry, IHooks(address(hook)), jpyc);

        vm.startPrank(operator);
        registry.verifyCompany(supplier, keccak256("corp:1"), "Sakura Seiko");
        registry.verifyCompany(debtor, keccak256("corp:2"), "Tokyo Motors");
        risk.setRegistry(address(registry));
        risk.setVault(address(vault));
        vault.setRegistry(address(registry));
        risk.rate(debtor, 2); // 1% base + 2% = 3%
        registry.setVenue(address(manager), true);
        registry.approveInvestor(investor, true);
        vm.stopPrank();

        for (uint256 i; i < 3; i++) {
            address a = [investor, anon, debtor][i];
            jpyc.mint(a, 5_000_000e18);
            vm.prank(a);
            jpyc.approve(address(market), type(uint256).max);
        }
    }

    function _dl() internal view returns (uint256) {
        return block.timestamp + 10 minutes;
    }

    function _invoice(uint256 face, uint256 days_, string memory ref) internal returns (uint256 id, InvoiceToken t) {
        vm.prank(supplier);
        id = registry.registerInvoice(debtor, face, uint64(block.timestamp + days_ * 1 days), keccak256(bytes(ref)), ref);
        vm.prank(debtor);
        registry.acceptInvoice(id);
        t = registry.invoice(id).token;
        vm.prank(supplier);
        t.approve(address(market), type(uint256).max);
    }

    function _pool(uint256 id, uint256 bids) internal returns (uint256 pos) {
        market.createPool(id);
        vm.prank(investor);
        (pos,) = market.postBids(id, bids, 0, 150, _dl());
    }

    // ---------------------------------------------------------------- 1. why Uniswap
    /// "Any APPROVED investor can fund invoices; an unapproved wallet is stopped up front (funds never get stuck)."
    function test_claim_onlyApprovedInvestorsCanFundOrBuy() public {
        (uint256 id,) = _invoice(1_000_000e18, 90, "C-1");
        _pool(id, 600_000e18);
        vm.startPrank(anon);
        vm.expectRevert(abi.encodeWithSelector(TegataMarket.NotEligible.selector, anon));
        market.postBids(id, 100_000e18, 0, 150, _dl());
        vm.expectRevert(abi.encodeWithSelector(TegataMarket.NotEligible.selector, anon));
        market.buy(id, 1_000e18, 0, _dl());
        vm.stopPrank();
    }

    /// "The supplier can sell ¥10,000 or ¥200,000 of an invoice at any time, settled in JPYC."
    function test_claim_supplierSellsAnySizeWithinDepth() public {
        (uint256 id,) = _invoice(1_000_000e18, 90, "C-2");
        _pool(id, 600_000e18);
        vm.startPrank(supplier);
        uint256 small = market.sell(id, 10_000e18, 9_700e18, _dl());
        uint256 large = market.sell(id, 200_000e18, 194_000e18, _dl());
        vm.stopPrank();
        emit log_named_decimal_uint("JPYC for 10,000 face ", small, 18);
        emit log_named_decimal_uint("JPYC for 200,000 face", large, 18);
        assertEq(jpyc.balanceOf(supplier), small + large);
    }

    /// "Investors can exit before the due date by selling invoice tokens back."
    function test_claim_investorCanExitBeforeMaturity() public {
        (uint256 id, InvoiceToken t) = _invoice(1_000_000e18, 90, "C-3");
        uint256 pos = _pool(id, 600_000e18);
        vm.prank(supplier);
        market.sell(id, 100_000e18, 0, _dl());
        vm.prank(investor);
        market.withdrawBids(pos, _dl()); // investor now holds ~100k of invoice tokens + remaining JPYC
        uint256 held = t.balanceOf(investor);
        assertApproxEqAbs(held, 100_000e18, 1e18);

        // Another approved investor makes a market; the first one exits 30 days later, before maturity.
        address lp2 = makeAddr("second investor");
        jpyc.mint(lp2, 1_000_000e18);
        vm.startPrank(operator);
        registry.approveInvestor(lp2, true);
        vm.stopPrank();
        vm.warp(block.timestamp + 30 days);
        vm.startPrank(lp2);
        jpyc.approve(address(market), type(uint256).max);
        market.postBids(id, 500_000e18, 0, 150, _dl());
        vm.stopPrank();

        vm.startPrank(investor);
        t.approve(address(market), type(uint256).max);
        uint256 before = jpyc.balanceOf(investor);
        market.sell(id, held, 0, _dl());
        vm.stopPrank();
        assertEq(t.balanceOf(investor), 0);
        assertGt(jpyc.balanceOf(investor), before);
    }

    // ---------------------------------------------------------------- 2. how the token is pegged
    /// "Tokens are minted only on acceptance, exactly equal to the invoice amount; nobody can mint more."
    function test_claim_supplyFixedAtFace() public {
        vm.prank(supplier);
        uint256 id = registry.registerInvoice(debtor, 2_000e18, uint64(block.timestamp + 60 days), keccak256("fx"), "FX-1");
        InvoiceToken t = registry.invoice(id).token;
        assertEq(t.totalSupply(), 0); // nothing before the debtor accepts
        vm.prank(debtor);
        registry.acceptInvoice(id);
        assertEq(t.totalSupply(), 2_000e18);
        vm.prank(supplier);
        vm.expectRevert(InvoiceToken.NotRegistry.selector);
        t.mint(supplier, 1e18);
    }

    /// "Fair price starts below ¥1 and rises every day to exactly ¥1 on the due date."
    function test_claim_priceConvergesToOneYen() public {
        (uint256 id,) = _invoice(2_000e18, 60, "PX-1");
        uint64 mat = registry.invoice(id).maturity;
        uint256 prev;
        for (uint256 d; d <= 60; d += 10) {
            uint256 p = registry.fairPrice(id, block.timestamp + d * 1 days);
            assertGt(p, prev);
            assertLe(p, 1e18);
            prev = p;
        }
        assertEq(registry.fairPrice(id, mat), 1e18);
    }

    // ---------------------------------------------------------------- 3. the ¥2,000 invoice
    /// "The invoice amount never changes; the token price only decides what a buyer pays today."
    function test_claim_2000yenInvoice_faceFixed_priceMoves() public {
        (uint256 id, InvoiceToken t) = _invoice(2_000e18, 60, "SKR-2000");
        uint64 mat = registry.invoice(id).maturity;

        uint256 normal = 2_000 * registry.fairPrice(id, block.timestamp); // value of 2,000 tokens today (1e18 yen)
        emit log_named_decimal_uint("fair price, G2 3%, 60d      ", registry.fairPrice(id, block.timestamp), 18);
        emit log_named_decimal_uint("buyer pays for 2,000 tokens ", normal, 18);
        assertApproxEqAbs(normal, 1_990.19e18, 0.01e18);

        vm.prank(operator);
        risk.rate(debtor, 5); // downgrade: 1% + 16% = 17%
        uint256 down = 2_000 * registry.fairPrice(id, block.timestamp);
        emit log_named_decimal_uint("fair price after downgrade  ", registry.fairPrice(id, block.timestamp), 18);
        emit log_named_decimal_uint("buyer pays after downgrade  ", down, 18);
        assertApproxEqAbs(down, 1_945.63e18, 0.01e18);
        assertEq(registry.invoice(id).face, 2_000e18); // the debt did not change

        // Two days before maturity (trading closes 1 day before).
        uint256 late = 2_000 * registry.fairPrice(id, mat - 2 days);
        emit log_named_decimal_uint("buyer pays 2 days before due", late, 18);
        assertApproxEqAbs(late, 1_998.14e18, 0.01e18);

        // The debtor still owes exactly ¥2,000 and settles with ¥2,000; holders redeem 1:1.
        vm.warp(mat);
        vm.startPrank(debtor);
        jpyc.approve(address(registry), 2_000e18);
        registry.pay(id, 2_000e18);
        vm.stopPrank();
        assertEq(uint8(registry.invoice(id).status), uint8(InvoiceRegistry.Status.Settled));
        uint256 b = jpyc.balanceOf(supplier);
        vm.prank(supplier);
        registry.redeem(id, 2_000e18);
        assertEq(jpyc.balanceOf(supplier) - b, 2_000e18);
        assertEq(t.totalSupply(), 0); // redeemed tokens are destroyed
    }

    /// "Trading closes one day before the due date" (so the holder set is fixed for payment).
    function test_claim_tradingClosesOneDayBeforeDue() public {
        (uint256 id,) = _invoice(1_000_000e18, 60, "CUT-1");
        _pool(id, 600_000e18);
        vm.warp(registry.invoice(id).maturity - 1 days);
        vm.prank(supplier);
        vm.expectRevert(); // MaturityCurveHook.TradingClosed
        market.sell(id, 1_000e18, 0, _dl());
    }
}
