// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {stdError} from "forge-std/StdError.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {TegataBase} from "./TegataBase.sol";
import {InvoiceRegistry} from "../src/rwa/InvoiceRegistry.sol";
import {InvoiceToken} from "../src/rwa/InvoiceToken.sol";
import {CollateralVault} from "../src/rwa/CollateralVault.sol";
import {TegataMarket} from "../src/periphery/TegataMarket.sol";

/// Adversarial end-to-end cases for the open-access deployment, configured like live Sepolia: no KYB/KYC, unrated
/// debtors must lock 20% to accept, rated grades optional, 3% APR from a ¥200,000 reward pool.
///   test_FIXED_*     an attack found earlier; the test PASSES when the attack now FAILS.
///   test_RESIDUAL_*  still possible by design or not yet fixed; the test PASSES when the attack still WORKS.
///   test_HOLDS_*     a protection that works.
contract EdgeCasesTest is TegataBase {
    TegataMarket market;
    address mallory = makeAddr("mallory (attacker, supplier wallet)");
    address sybil = makeAddr("mallory's second wallet (debtor)");
    address victim = makeAddr("retail investor");

    function setUp() public override {
        super.setUp();
        market = new TegataMarket(manager, registry, IHooks(address(hook)), jpyc);
        jpyc.mint(operator, 200_000e18);
        vm.startPrank(operator);
        vault.setAprBps(300);
        jpyc.approve(address(vault), type(uint256).max);
        vault.fundRewards(200_000e18);
        vm.stopPrank();
        assertEq(vault.requiredBps(0), 2_000); // unrated: 20% to accept
        address[4] memory who = [mallory, sybil, victim, debtor];
        for (uint256 i; i < who.length; i++) {
            jpyc.mint(who[i], 20_000_000e18);
            vm.startPrank(who[i]);
            jpyc.approve(address(market), type(uint256).max);
            jpyc.approve(address(vault), type(uint256).max);
            jpyc.approve(address(registry), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _dl() internal view returns (uint256) {
        return block.timestamp + 10 minutes;
    }

    function _register(address from, address to, uint256 face, uint64 mat, string memory doc) internal returns (uint256) {
        vm.prank(from);
        return registry.registerInvoice(to, face, mat, keccak256(bytes(doc)), doc);
    }

    function _contains(bytes memory h, bytes memory n) internal pure returns (bool) {
        if (n.length > h.length) return false;
        for (uint256 i; i <= h.length - n.length; i++) {
            bool ok = true;
            for (uint256 j; j < n.length && ok; j++) ok = h[i + j] == n[j];
            if (ok) return true;
        }
        return false;
    }

    // ============================================================== 1. self-dealing fraud (critical)

    /// With 20% collateral at acceptance the fraudster must put money at risk, and holders recover the seized 20%.
    /// It still pays: sell more than the collateral, never pay. The chosen fix limits, not prevents, this.
    function test_RESIDUAL_selfDealtFraudStillPaysAboveTheCollateral() public {
        uint256 id = _register(mallory, sybil, 1_000_000e18, maturity, "FAKE-001");
        vm.prank(sybil);
        vm.expectRevert(abi.encodeWithSelector(InvoiceRegistry.CollateralRequired.selector, sybil, 200_000e18, 0));
        registry.acceptInvoice(id); // can't accept for free any more
        vm.startPrank(sybil);
        vault.deposit(200_000e18);
        registry.acceptInvoice(id);
        vm.stopPrank();

        market.createPool(id);
        vm.prank(victim);
        (uint256 pos,) = market.postBids(id, 600_000e18, 0, 150, _dl());
        InvoiceToken t = registry.invoice(id).token;
        uint256 start = jpyc.balanceOf(mallory) + jpyc.balanceOf(sybil) + 200_000e18; // incl. locked collateral
        vm.startPrank(mallory);
        t.approve(address(market), type(uint256).max);
        market.sell(id, 500_000e18, 0, _dl());
        vm.stopPrank();

        vm.warp(maturity + 3 days);
        registry.markDefault(id); // seizes the 200,000
        vm.startPrank(victim);
        market.withdrawBids(pos, _dl());
        uint256 victimTokens = t.balanceOf(victim);
        uint256 victimGot = registry.redeem(id, victimTokens);
        vm.stopPrank();
        uint256 kept = t.balanceOf(mallory);
        vm.prank(mallory);
        registry.redeem(id, kept); // the fraudster redeems its own unsold half too
        uint256 end = jpyc.balanceOf(mallory) + jpyc.balanceOf(sybil);

        emit log_named_decimal_uint("victim paid for face ", victimTokens, 18);
        emit log_named_decimal_uint("victim recovered     ", victimGot, 18);
        emit log_named_decimal_uint("fraudster net profit ", end - start, 18);
        assertEq(victimGot, victimTokens / 5); // 20% recovery (was 0%)
        assertGt(end, start); // still profitable
    }

    // ============================================================== 2. names (critical)

    function test_FIXED_exactNameCannotBeTaken() public {
        vm.prank(sybil);
        vm.expectRevert(abi.encodeWithSelector(InvoiceRegistry.NameTaken.selector, debtor));
        registry.setCompanyName(unicode"東京モーターズ株式会社");
    }

    function test_HOLDS_operatorCanTakeDownAName() public {
        vm.prank(sybil);
        registry.setCompanyName(unicode"トヨタ自動車株式会社");
        vm.prank(operator);
        registry.clearCompanyName(sybil);
        address toyota = makeAddr("the real Toyota");
        vm.prank(toyota);
        registry.setCompanyName(unicode"トヨタ自動車株式会社"); // freed for its rightful owner
        assertEq(registry.companyName(sybil), "");
    }

    function test_HOLDS_renamingFreesTheOldName() public {
        vm.startPrank(sybil);
        registry.setCompanyName("Old KK");
        registry.setCompanyName("New KK");
        vm.stopPrank();
        vm.prank(mallory);
        registry.setCompanyName("Old KK");
    }

    /// Uniqueness is exact-match only: a look-alike (trailing space, full-width letters) still gets through. Names
    /// stay self-declared; the app marks unrated companies "unverified".
    function test_RESIDUAL_lookAlikeNamesStillAllowed() public {
        vm.prank(sybil);
        registry.setCompanyName(unicode"東京モーターズ株式会社 ");
    }

    // ============================================================== 3–4. pending-invoice spam (high)

    function test_FIXED_pendingSpamCannotBlockADebtor() public {
        vm.prank(mallory);
        vm.expectRevert(InvoiceRegistry.InvalidTerms.selector);
        registry.registerInvoice(debtor, type(uint256).max, maturity, keccak256("huge"), "");
        uint256 max = registry.MAX_FACE();
        for (uint256 i; i < 3; i++) _register(mallory, debtor, max, maturity, string.concat("SPAM-", vm.toString(i)));
        assertEq(registry.outstandingOf(debtor), FACE); // only the accepted invoice counts
        uint256 id = _register(supplier, debtor, 1_000e18, maturity, "LEGIT-1");
        vm.prank(debtor);
        registry.acceptInvoice(id);
    }

    function test_FIXED_pendingSpamCannotRepriceADebtor() public {
        vm.prank(debtor);
        vault.deposit(1_000_000e18); // 100% coverage -> −2%, floored at the 1% base
        assertEq(registry.rateOf(invoiceId), 100);
        _register(mallory, debtor, registry.MAX_FACE(), maturity, "GRIEF-2"); // never accepted
        assertEq(registry.rateOf(invoiceId), 100);
    }

    // ============================================================== 5. document hash (high)

    function test_FIXED_frontRunningADocHashDoesNotBlockTheRealInvoice() public {
        bytes32 doc = keccak256("real-invoice.pdf");
        vm.prank(mallory); // front-runs Sakura's pending tx with the same hash
        registry.registerInvoice(debtor, 1e18, maturity, doc, "");
        vm.prank(supplier);
        registry.registerInvoice(debtor, 500_000e18, maturity, doc, "SKR-REAL"); // unaffected
    }

    function test_HOLDS_sameSupplierCannotFinanceTheSameDocumentTwice() public {
        vm.prank(supplier);
        vm.expectRevert(abi.encodeWithSelector(InvoiceRegistry.DuplicateInvoice.selector, invoiceId));
        registry.registerInvoice(debtor, FACE, maturity, DOC, ""); // 二重譲渡 still blocked
    }

    function test_FIXED_rejectedInvoiceCanBeCorrectedAndReRegistered() public {
        bytes32 doc = keccak256("typo.pdf");
        vm.prank(supplier);
        uint256 id = registry.registerInvoice(debtor, 5_000e18, maturity, doc, "TYPO");
        vm.prank(debtor);
        registry.rejectInvoice(id, "wrong amount");
        vm.prank(supplier);
        registry.registerInvoice(debtor, 4_500e18, maturity, doc, "TYPO-FIXED");
    }

    // ============================================================== 6. collateral withdrawal (high)

    function test_FIXED_collateralCannotBeWithdrawnBeforeDefault() public {
        uint256 id = _register(mallory, sybil, 1_000_000e18, maturity, "COL-1");
        vm.startPrank(sybil);
        vault.deposit(1_000_000e18); // full coverage: 17% -> 15%
        registry.acceptInvoice(id);
        vm.stopPrank();
        assertEq(registry.rateOf(id), 1_500);

        vm.warp(maturity - 1 days);
        vm.prank(sybil);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.BelowRequired.selector, 1_000_000e18, 0));
        vault.withdraw(1_000_000e18);
        vm.warp(maturity + 3 days);
        registry.markDefault(id);
        assertEq(registry.invoice(id).funded, 1_000_000e18); // holders are made whole from the collateral
    }

    // ============================================================== 7. reward pool (high)

    function test_FIXED_parkedJpycEarnsNoRewards() public {
        address whale = makeAddr("yield farmer, no invoices");
        jpyc.mint(whale, 10_000_000e18);
        vm.startPrank(whale);
        jpyc.approve(address(vault), type(uint256).max);
        vault.deposit(10_000_000e18);
        vm.stopPrank();
        vm.warp(FRI_1000_JST + 365 days);
        assertEq(vault.interestOf(whale), 0);
        vm.prank(whale);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.NothingToClaim.selector, 0, 200_000e18));
        vault.claimInterest();
    }

    // ============================================================== medium, not in scope of this fix

    /// Credit farming: 10 self-invoices of 1 wei (with 1 wei of collateral), paid on time, earn the maximum −1%.
    function test_RESIDUAL_onTimeHistoryFarmedWithDustInvoices() public {
        vm.prank(sybil);
        vault.deposit(10);
        for (uint256 i; i < 10; i++) {
            uint256 id = _register(mallory, sybil, 1, maturity, string.concat("DUST-", vm.toString(i)));
            vm.startPrank(sybil);
            registry.acceptInvoice(id);
            registry.pay(id, 1);
            vm.stopPrank();
        }
        vm.prank(sybil);
        vault.withdraw(10);
        assertEq(risk.rateBps(sybil), 1_600);
    }

    /// Reputation is per wallet: a debtor that defaulted uses a fresh wallet and is priced like a clean one.
    function test_RESIDUAL_defaulterResetsHistoryWithNewWallet() public {
        uint256 id = _register(mallory, sybil, 1_000e18, maturity, "D-1");
        vm.startPrank(sybil);
        vault.deposit(200e18);
        registry.acceptInvoice(id);
        vm.stopPrank();
        vm.warp(maturity + 3 days);
        registry.markDefault(id);
        assertEq(risk.rateBps(sybil), 2_700); // 17% + 10% default penalty
        assertEq(risk.rateBps(makeAddr("sybil's next wallet")), 1_700);
    }

    /// The curve is only enforced in the hooked Tegata pool; invoice tokens can be traded anywhere else at any price.
    function test_RESIDUAL_curveBypassedInUnhookedPool() public {
        PoolKey memory k = _keyFor(address(token));
        k.hooks = IHooks(address(0));
        bool tokenIs0 = Currency.unwrap(k.currency0) == address(token);
        uint256 p01 = tokenIs0 ? 0.5e18 : 2e18; // 0.5 JPYC per invoice token
        uint160 sqrtP = uint160(Math.sqrt(Math.mulDiv(p01, 1 << 192, 1e18)));
        manager.initialize(k, sqrtP);

        int24 tick = TickMath.getTickAtSqrtPrice(sqrtP);
        int24 aligned = (tick / SPACING) * SPACING;
        (int24 lo, int24 hi) = tokenIs0
            ? (aligned - SPACING - 600, aligned - SPACING)
            : (aligned + SPACING, aligned + SPACING + 600);
        uint128 liq = tokenIs0
            ? LiquidityAmounts.getLiquidityForAmount1(TickMath.getSqrtPriceAtTick(lo), TickMath.getSqrtPriceAtTick(hi), 100_000e18)
            : LiquidityAmounts.getLiquidityForAmount0(TickMath.getSqrtPriceAtTick(lo), TickMath.getSqrtPriceAtTick(hi), 100_000e18);
        vm.startPrank(mallory);
        jpyc.approve(address(lpRouter), type(uint256).max);
        lpRouter.modifyLiquidity(k, ModifyLiquidityParams(lo, hi, int256(uint256(liq)), bytes32(0)), "");
        vm.stopPrank();

        uint256 before = jpyc.balanceOf(supplier);
        vm.prank(supplier);
        swapRouter.swap(
            k,
            SwapParams(tokenIs0, -int256(10_000e18), tokenIs0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
        assertLt(jpyc.balanceOf(supplier) - before, 5_100e18); // fair value on the curve is ~9,927
    }

    /// Metadata JSON only escapes `"` and `\`: a newline in a name makes contractURI invalid JSON.
    function test_RESIDUAL_controlCharactersBreakMetadataJson() public {
        vm.prank(sybil);
        registry.setCompanyName("Evil\nCo");
        uint256 id = _register(mallory, sybil, 1_000e18, maturity, "JSON-1");
        assertTrue(_contains(bytes(registry.invoiceMetadata(id)), bytes("Evil\nCo")));
    }

    /// No recovery path after default: the debtor can't pay the rest once an invoice is marked Defaulted.
    function test_RESIDUAL_debtorCannotPayAfterDefault() public {
        vm.warp(maturity + 3 days);
        registry.markDefault(invoiceId);
        vm.prank(debtor);
        vm.expectRevert(abi.encodeWithSelector(InvoiceRegistry.BadStatus.selector, InvoiceRegistry.Status.Defaulted));
        registry.pay(invoiceId, FACE);
    }

    // ============================================================== HOLDS

    function test_HOLDS_registrationIsNeverBlockedByTheDebtor() public {
        address stranger = makeAddr("unrated debtor with no collateral");
        _register(supplier, stranger, 1_000_000e18, maturity, "OPEN-1");
    }

    function test_HOLDS_onlyTheNamedDebtorCanAccept() public {
        uint256 id = _register(mallory, debtor, 1_000e18, maturity, "H-1");
        vm.prank(mallory);
        vm.expectRevert(InvoiceRegistry.NotDebtor.selector);
        registry.acceptInvoice(id);
        assertEq(registry.invoice(id).token.totalSupply(), 0);
    }

    function test_HOLDS_strangersCannotUseOperatorOrRegistryPowers() public {
        bytes32 op = registry.OPERATOR_ROLE();
        vm.startPrank(mallory);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, mallory, op));
        registry.setFrozen(invoiceId, true);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, mallory, op));
        registry.clearCompanyName(debtor);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, mallory, op));
        risk.rate(mallory, 1);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, mallory, op));
        vault.setAprBps(2_000);
        vm.expectRevert(CollateralVault.NotRegistry.selector);
        vault.seize(debtor, invoiceId, 1);
        vm.expectRevert(CollateralVault.NotRegistry.selector);
        vault.sync(debtor);
        vm.expectRevert(InvoiceToken.NotRegistry.selector);
        token.mint(mallory, 1e18);
        vm.expectRevert(InvoiceToken.NotRegistry.selector);
        token.burn(supplier, 1e18);
        vm.stopPrank();
    }

    function test_HOLDS_redeemNeedsSettlementAndRealTokens() public {
        vm.prank(supplier);
        vm.expectRevert(abi.encodeWithSelector(InvoiceRegistry.BadStatus.selector, InvoiceRegistry.Status.Accepted));
        registry.redeem(invoiceId, 1e18);

        vm.prank(debtor);
        registry.pay(invoiceId, FACE);
        uint256 bal = jpyc.balanceOf(mallory);
        vm.prank(mallory); // holds no tokens: the burn fails, so the JPYC payout is rolled back
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, mallory, 0, 1_000e18));
        registry.redeem(invoiceId, 1_000e18);
        assertEq(jpyc.balanceOf(mallory), bal);
    }

    function test_HOLDS_overpaymentIsCappedAndDefaultNeedsGrace() public {
        vm.expectRevert(abi.encodeWithSelector(InvoiceRegistry.NotYetDefaultable.selector, uint256(maturity) + 3 days));
        registry.markDefault(invoiceId);
        uint256 bal = jpyc.balanceOf(mallory);
        vm.prank(mallory); // anyone may pay; paying more than due only takes what's due
        registry.pay(invoiceId, FACE * 2);
        assertEq(bal - jpyc.balanceOf(mallory), FACE);
        assertEq(uint8(registry.invoice(invoiceId).status), uint8(InvoiceRegistry.Status.Settled));
    }

    function test_HOLDS_hookedPoolRejectsOffCurveDump() public {
        vm.expectRevert(); // PriceOffCurve (wrapped by the PoolManager)
        _sellInvoice(supplier, 800_000e18);
    }

    function test_HOLDS_bidPositionsBelongToTheirOwner() public {
        uint256 id = _register(supplier, debtor, 100_000e18, maturity, "H-POS");
        vm.prank(debtor);
        registry.acceptInvoice(id);
        market.createPool(id);
        vm.prank(victim);
        (uint256 pos,) = market.postBids(id, 50_000e18, 0, 150, _dl());
        vm.prank(mallory);
        vm.expectRevert(TegataMarket.NotOwner.selector);
        market.withdrawBids(pos, _dl());
    }

    function test_HOLDS_vaultStaysSolventUnderAllFlows() public {
        vm.prank(debtor);
        vault.deposit(300_000e18);
        uint256 id = _register(mallory, sybil, 100_000e18, maturity, "SOLV-1");
        vm.startPrank(sybil);
        vault.deposit(50_000e18);
        registry.acceptInvoice(id);
        vm.stopPrank();
        vm.warp(maturity + 3 days);
        registry.markDefault(id); // seizes sybil's 50,000
        vm.prank(sybil);
        vault.claimInterest();
        vm.startPrank(debtor);
        registry.pay(invoiceId, FACE); // frees its collateral
        vault.withdraw(300_000e18);
        vault.claimInterest();
        vm.stopPrank();
        assertEq(jpyc.balanceOf(address(vault)), vault.totalCollateral() + vault.rewardReserve());
    }
}
