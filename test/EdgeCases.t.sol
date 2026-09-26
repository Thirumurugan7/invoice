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

/// Adversarial end-to-end cases for the open-access deployment, configured like live Sepolia: no KYB/KYC, collateral
/// optional for every grade (0%), 3% APR from a ¥200,000 reward pool.
///   test_BREAK_*  proof-of-concept: the test PASSES when the attack or failure SUCCEEDS.
///   test_HOLDS_*  the protection works.
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
        vault.setRequiredBps(4, 0); // live config: collateral optional
        vault.setRequiredBps(5, 0);
        vault.setAprBps(300);
        jpyc.approve(address(vault), type(uint256).max);
        vault.fundRewards(200_000e18);
        vm.stopPrank();
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

    // ============================================================== BREAKS

    /// 1. Self-dealing fraud. One person controls a "supplier" and a "debtor" wallet, invoices themselves, accepts,
    ///    sells the tokens to investors, never pays. No KYB, no required collateral: investors lose everything.
    ///    The G5 rate (17%/yr) only discounts ~4% over 90 days; it doesn't price a ~100% fraud loss.
    function test_BREAK_selfDealtInvoiceDrainsInvestors() public {
        vm.prank(sybil);
        registry.setCompanyName(unicode"トヨタ自動車株式会社 (Toyota)"); // self-declared, unverified
        uint256 id = _register(mallory, sybil, 1_000_000e18, maturity, "FAKE-001");
        vm.prank(sybil);
        registry.acceptInvoice(id);

        market.createPool(id);
        vm.prank(victim);
        (uint256 pos,) = market.postBids(id, 600_000e18, 0, 150, _dl());

        InvoiceToken t = registry.invoice(id).token;
        uint256 before = jpyc.balanceOf(mallory);
        vm.startPrank(mallory);
        t.approve(address(market), type(uint256).max);
        market.sell(id, 500_000e18, 0, _dl());
        vm.stopPrank();
        uint256 stolen = jpyc.balanceOf(mallory) - before;

        vm.warp(maturity + 3 days);
        registry.markDefault(id);
        vm.startPrank(victim);
        market.withdrawBids(pos, _dl());
        uint256 held = t.balanceOf(victim);
        uint256 recovered = registry.redeem(id, held);
        vm.stopPrank();

        emit log_named_decimal_uint("attacker walked away with JPYC", stolen, 18);
        emit log_named_decimal_uint("victim paid for face          ", held, 18);
        emit log_named_decimal_uint("victim recovered              ", recovered, 18);
        assertGt(stolen, 470_000e18);
        assertEq(recovered, 0);
    }

    /// 2. Name impersonation: any wallet can claim any company's name, including a rated debtor's exact name.
    function test_BREAK_anyoneCanClaimAnyCompanyName() public {
        vm.prank(sybil);
        registry.setCompanyName(unicode"東京モーターズ株式会社");
        assertEq(registry.companyName(sybil), registry.companyName(debtor));
    }

    /// 3. Griefing: a pending invoice counts toward the debtor's outstanding. One huge pending invoice against any
    ///    company overflows `outstandingOf`, so NOBODY can invoice that company until it notices and rejects.
    function test_BREAK_pendingInvoiceSpamBlocksAnyDebtor() public {
        uint256 room = type(uint256).max - registry.outstandingOf(debtor);
        _register(mallory, debtor, room, maturity, "GRIEF-1");
        vm.prank(supplier);
        vm.expectRevert(stdError.arithmeticError);
        registry.registerInvoice(debtor, 1_000e18, maturity, keccak256("legit"), "LEGIT-1");

        vm.prank(debtor);
        registry.rejectInvoice(2, "spam"); // the only way out, one invoice at a time
        _register(supplier, debtor, 1_000e18, maturity, "LEGIT-1");
    }

    /// 4. Rate manipulation: collateral coverage = collateral / outstanding, and pending (unaccepted) invoices count.
    ///    A stranger's pending invoice wipes out a debtor's collateral discount and reprices ALL its live invoices.
    function test_BREAK_pendingSpamRepricesCollateralizedDebtor() public {
        vm.prank(debtor);
        vault.deposit(1_000_000e18); // 100% coverage -> −2%, floored at the 1% base
        uint256 fairBefore = registry.fairPrice(invoiceId, block.timestamp);
        assertEq(registry.rateOf(invoiceId), 100);

        _register(mallory, debtor, 1e30, maturity, "GRIEF-2"); // never accepted
        assertEq(registry.rateOf(invoiceId), 300);
        assertLt(registry.fairPrice(invoiceId, block.timestamp), fairBefore);
    }

    /// 5. Document-hash squatting: the hash is public in the mempool. Anyone can front-run a registration with the same
    ///    docHash; even after the debtor rejects the fake, the hash stays burned, so the real invoice can never be
    ///    registered. (Also hits honest mistakes: a rejected invoice's PDF can't be re-registered.)
    function test_BREAK_docHashSquattingBlocksRealInvoiceForever() public {
        bytes32 doc = keccak256("real-invoice.pdf");
        vm.prank(mallory); // front-runs Sakura's pending tx
        uint256 fake = registry.registerInvoice(debtor, 1e18, maturity, doc, "");
        vm.prank(debtor);
        registry.rejectInvoice(fake, "not ours");

        vm.prank(supplier);
        vm.expectRevert(abi.encodeWithSelector(InvoiceRegistry.DuplicateInvoice.selector, fake));
        registry.registerInvoice(debtor, 500_000e18, maturity, doc, "SKR-REAL");
    }

    /// 6. Optional collateral is not a commitment: it lowers the rate (investors pay more) and can be withdrawn the
    ///    day before default, so nothing is seized.
    function test_BREAK_collateralDiscountThenWithdrawBeforeDefault() public {
        uint256 id = _register(mallory, sybil, 1_000_000e18, maturity, "COL-1");
        vm.prank(sybil);
        registry.acceptInvoice(id);
        vm.prank(sybil);
        vault.deposit(1_000_000e18); // full coverage: 17% -> 15%
        assertEq(registry.rateOf(id), 1_500);

        vm.warp(maturity - 1 days);
        vm.prank(sybil);
        vault.withdraw(1_000_000e18); // allowed: nothing is required
        vm.warp(maturity + 3 days);
        registry.markDefault(id);
        assertEq(registry.invoice(id).funded, 0); // nothing seized for holders
    }

    /// 7. The reward pool pays anyone who parks JPYC, not just debtors: a whale with no invoices drains it.
    function test_BREAK_rewardPoolDrainedByNonDebtor() public {
        address whale = makeAddr("yield farmer, no invoices");
        jpyc.mint(whale, 10_000_000e18);
        vm.startPrank(whale);
        jpyc.approve(address(vault), type(uint256).max);
        vault.deposit(10_000_000e18);
        vm.stopPrank();
        vm.prank(debtor);
        vault.deposit(100_000e18); // a real debtor

        vm.warp(FRI_1000_JST + 365 days);
        vm.prank(whale);
        assertEq(vault.claimInterest(), 200_000e18); // the whole pool
        vm.prank(debtor);
        vm.expectRevert(abi.encodeWithSelector(CollateralVault.NothingToClaim.selector, 3_000e18, 0));
        vault.claimInterest();
    }

    /// 8. Credit farming: 10 self-invoices of 1 wei, paid on time, buy the maximum on-time credit (−1%) for gas only.
    function test_BREAK_onTimeHistoryFarmedWithDustInvoices() public {
        assertEq(risk.rateBps(sybil), 1_700);
        for (uint256 i; i < 10; i++) {
            uint256 id = _register(mallory, sybil, 1, maturity, string.concat("DUST-", vm.toString(i)));
            vm.startPrank(sybil);
            registry.acceptInvoice(id);
            registry.pay(id, 1);
            vm.stopPrank();
        }
        assertEq(risk.rateBps(sybil), 1_600);
    }

    /// 9. Reputation is per wallet: a debtor that defaulted just uses a fresh wallet and is priced like a clean one.
    function test_BREAK_defaulterResetsHistoryWithNewWallet() public {
        uint256 id = _register(mallory, sybil, 1_000e18, maturity, "D-1");
        vm.prank(sybil);
        registry.acceptInvoice(id);
        vm.warp(maturity + 3 days);
        registry.markDefault(id);
        assertEq(risk.rateBps(sybil), 2_700); // 17% + 10% default penalty
        assertEq(risk.rateBps(makeAddr("sybil's next wallet")), 1_700);
    }

    /// 10. The curve is only enforced in the hooked Tegata pool. Invoice tokens are plain ERC-20s, so anyone can open
    ///     an unhooked Uniswap v4 pool (or use any DEX/OTC) and trade them at any price, e.g. 50% of face.
    function test_BREAK_curveBypassedInUnhookedPool() public {
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
        uint256 got = jpyc.balanceOf(supplier) - before;
        emit log_named_decimal_uint("10,000 face sold off-curve for", got, 18);
        assertLt(got, 5_100e18); // fair value on the curve is ~9,927
    }

    /// 11. On-chain metadata JSON only escapes `"` and `\`: a name with a newline makes contractURI invalid JSON
    ///     (wallets/indexers/the app's record viewer fail to parse it).
    function test_BREAK_controlCharactersBreakMetadataJson() public {
        vm.prank(sybil);
        registry.setCompanyName("Evil\nCo");
        uint256 id = _register(mallory, sybil, 1_000e18, maturity, "JSON-1");
        assertTrue(_contains(bytes(registry.invoiceMetadata(id)), bytes("Evil\nCo"))); // raw control char in a JSON string
    }

    /// 12. No recovery after default: once marked Defaulted, the debtor can't pay the rest, so holders are stuck with
    ///     whatever was paid (plus seized collateral), even if the debtor wants to cure a day later.
    function test_BREAK_debtorCannotPayAfterDefault() public {
        vm.warp(maturity + 3 days);
        registry.markDefault(invoiceId);
        vm.prank(debtor);
        vm.expectRevert(abi.encodeWithSelector(InvoiceRegistry.BadStatus.selector, InvoiceRegistry.Status.Defaulted));
        registry.pay(invoiceId, FACE);
    }

    // ============================================================== HOLDS

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
        risk.rate(mallory, 1);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, mallory, op));
        vault.setAprBps(2_000);
        vm.expectRevert(CollateralVault.NotRegistry.selector);
        vault.seize(debtor, invoiceId, 1);
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
        vm.prank(sybil);
        vault.deposit(50_000e18);
        uint256 id = _register(mallory, sybil, 100_000e18, maturity, "SOLV-1");
        vm.prank(sybil);
        registry.acceptInvoice(id);
        vm.warp(maturity + 3 days);
        registry.markDefault(id); // seizes sybil's 50,000
        vm.prank(sybil);
        vault.claimInterest();
        vm.prank(debtor);
        vault.withdraw(100_000e18);
        vm.prank(debtor);
        vault.claimInterest();
        assertEq(jpyc.balanceOf(address(vault)), vault.totalCollateral() + vault.rewardReserve());
    }
}
