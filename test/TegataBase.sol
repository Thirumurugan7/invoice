// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {InvoiceRegistry} from "../src/rwa/InvoiceRegistry.sol";
import {InvoiceToken} from "../src/rwa/InvoiceToken.sol";
import {MockJPYC} from "../src/rwa/MockJPYC.sol";
import {MaturityCurveHook} from "../src/hook/MaturityCurveHook.sol";

/// Fixture: operator verifies a supplier (下請 Sakura Seiko) and a debtor (Tokyo Motors); the supplier registers
/// a ¥1,000,000 invoice due in 90 days at a 3% discount rate; the debtor accepts; an investor posts JPYC bids along
/// the curve in a hooked Uniswap v4 pool.
abstract contract TegataBase is Test {
    using StateLibrary for IPoolManager;

    uint256 constant FRI_1000_JST = 1_790_298_000; // 2026-09-25 10:00 JST
    uint160 constant FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG;
    uint256 constant FACE = 1_000_000e18;
    uint32 constant DISCOUNT_BPS = 300;
    int24 constant SPACING = 10;
    bytes32 constant DOC = keccak256("invoice-2026-0925-SAKURA-TOKYOMOTORS.pdf");

    address operator = makeAddr("operator (MultiBaas Cloud Wallet)");
    address supplier = makeAddr("Sakura Seiko (supplier)");
    address debtor = makeAddr("Tokyo Motors (debtor)");
    address investor = makeAddr("investor");

    IPoolManager manager;
    MockJPYC jpyc;
    InvoiceRegistry registry;
    MaturityCurveHook hook;
    PoolModifyLiquidityTest lpRouter;
    PoolSwapTest swapRouter;
    InvoiceToken token;
    uint256 invoiceId;
    uint64 maturity;
    PoolKey key;
    int24 bidLower;
    int24 bidUpper;

    function setUp() public virtual {
        vm.warp(FRI_1000_JST);
        manager = new PoolManager(address(this));
        jpyc = new MockJPYC(address(this));
        registry = new InvoiceRegistry(jpyc, operator);

        bytes memory args = abi.encode(manager, registry, Currency.wrap(address(jpyc)), operator);
        (address hookAddr, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(MaturityCurveHook).creationCode, args);
        hook = new MaturityCurveHook{salt: salt}(manager, registry, Currency.wrap(address(jpyc)), operator);
        assertEq(address(hook), hookAddr);
        lpRouter = new PoolModifyLiquidityTest(manager);
        swapRouter = new PoolSwapTest(manager);

        vm.startPrank(operator);
        registry.verifyCompany(supplier, keccak256("corp:1010001000001"), unicode"株式会社さくら精工");
        registry.verifyCompany(debtor, keccak256("corp:2010001000002"), unicode"東京モーターズ株式会社");
        vm.stopPrank();

        maturity = uint64(block.timestamp + 90 days);
        vm.prank(supplier);
        invoiceId = registry.registerInvoice(debtor, FACE, maturity, DISCOUNT_BPS, DOC);
        vm.prank(debtor);
        registry.acceptInvoice(invoiceId);
        token = registry.invoice(invoiceId).token;

        jpyc.mint(investor, 2_000_000e18);
        jpyc.mint(debtor, 2_000_000e18);

        key = _keyFor(address(token));
        manager.initialize(key, _sqrtAtFair());
        _postInvestorBids(600_000e18);

        vm.startPrank(supplier);
        token.approve(address(swapRouter), type(uint256).max);
        jpyc.approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();
        vm.startPrank(investor);
        jpyc.approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- helpers
    function _keyFor(address t) internal view returns (PoolKey memory) {
        (address c0, address c1) = t < address(jpyc) ? (t, address(jpyc)) : (address(jpyc), t);
        return PoolKey(Currency.wrap(c0), Currency.wrap(c1), 3000, SPACING, IHooks(address(hook)));
    }

    function _tokenIs0() internal view returns (bool) {
        return Currency.unwrap(key.currency0) == address(token);
    }

    /// sqrtPriceX96 for the curve's fair price now. p01 = currency1 per currency0.
    function _sqrtAtFair() internal view returns (uint160) {
        uint256 fair = registry.fairPrice(invoiceId, block.timestamp); // JPYC per token, 1e18
        uint256 p01 = _tokenIs0Static() ? fair : 1e36 / fair;
        return uint160(Math.sqrt(Math.mulDiv(p01, 1 << 192, 1e18)));
    }

    function _tokenIs0Static() internal view returns (bool) {
        return address(token) < address(jpyc);
    }

    /// Investor posts JPYC-only liquidity just below the fair price (in JPYC-per-invoice terms): a bid ladder
    /// ~1.5% deep. Selling invoice tokens fills it.
    function _postInvestorBids(uint256 jpycAmount) internal {
        (uint160 sqrtP,,,) = _slot0();
        int24 tick = TickMath.getTickAtSqrtPrice(sqrtP);
        int24 aligned = (tick / SPACING) * SPACING;
        if (_tokenIs0()) {
            // JPYC is currency1: currency1-only range must be below current tick
            bidUpper = aligned < tick ? aligned : aligned - SPACING;
            bidLower = bidUpper - 150;
        } else {
            // JPYC is currency0: currency0-only range must be above current tick
            bidLower = aligned > tick ? aligned : aligned + SPACING;
            bidUpper = bidLower + 150;
        }
        uint160 sa = TickMath.getSqrtPriceAtTick(bidLower);
        uint160 sb = TickMath.getSqrtPriceAtTick(bidUpper);
        uint128 liq = _tokenIs0()
            ? LiquidityAmounts.getLiquidityForAmount1(sa, sb, jpycAmount)
            : LiquidityAmounts.getLiquidityForAmount0(sa, sb, jpycAmount);
        vm.startPrank(investor);
        jpyc.approve(address(lpRouter), type(uint256).max);
        lpRouter.modifyLiquidity(key, ModifyLiquidityParams(bidLower, bidUpper, int256(uint256(liq)), bytes32(0)), "");
        vm.stopPrank();
    }

    function _slot0() internal view returns (uint160 sqrtP, int24 tick, uint24 protocolFee, uint24 lpFee) {
        return manager.getSlot0(key.toId());
    }

    function _sellInvoice(address who, uint256 amount) internal returns (BalanceDelta) {
        bool zeroForOne = _tokenIs0();
        vm.prank(who);
        return swapRouter.swap(
            key,
            SwapParams(zeroForOne, -int256(amount), zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
    }

    function _buyInvoice(address who, uint256 jpycIn) internal returns (BalanceDelta) {
        bool zeroForOne = !_tokenIs0();
        vm.prank(who);
        return swapRouter.swap(
            key,
            SwapParams(zeroForOne, -int256(jpycIn), zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
    }

    function _hookRevert(bytes4 callback, bytes memory reason) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector, address(hook), callback, reason, abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    receive() external payable {}
}
