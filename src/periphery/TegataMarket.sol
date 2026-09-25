// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {InvoiceRegistry} from "../rwa/InvoiceRegistry.sol";

/// @title TegataMarket
/// @notice User-facing router for invoice/JPYC pools guarded by MaturityCurveHook:
///   - createPool(id): initialize the pool exactly on the invoice's discount curve;
///   - postBids(id, jpyc, depth): an investor posts single-sided JPYC liquidity just below the curve (a bid ladder);
///   - sell / buy: exact-input swaps (suppliers sell invoices for early cash, investors buy);
///   - withdrawBids(id): the investor pulls the position (JPYC + any invoice tokens it bought).
contract TegataMarket is IUnlockCallback {
    using SafeERC20 for IERC20;
    using StateLibrary for IPoolManager;

    int24 public constant TICK_SPACING = 10;
    uint24 public constant FEE = 3000;

    IPoolManager public immutable manager;
    InvoiceRegistry public immutable registry;
    IHooks public immutable hook;
    IERC20 public immutable jpyc;

    struct Position {
        int24 lower;
        int24 upper;
        uint128 liquidity;
    }

    mapping(uint256 id => mapping(address user => Position)) public bids;

    enum Action {
        Swap,
        Modify
    }

    event PoolCreated(uint256 indexed id, uint160 sqrtPriceX96, uint256 fairPrice);
    event BidsPosted(uint256 indexed id, address indexed investor, int24 lower, int24 upper, uint128 liquidity, uint256 jpyc);
    event BidsWithdrawn(uint256 indexed id, address indexed investor, uint128 liquidity);
    event Traded(uint256 indexed id, address indexed user, bool sellInvoice, uint256 amountIn, uint256 amountOut);

    error NotManager();
    error Slippage(uint256 out, uint256 minOut);
    error NoPosition();
    error UnknownInvoice();

    constructor(IPoolManager manager_, InvoiceRegistry registry_, IHooks hook_, IERC20 jpyc_) {
        manager = manager_;
        registry = registry_;
        hook = hook_;
        jpyc = jpyc_;
    }

    // ---------------------------------------------------------------- views
    function tokenOf(uint256 id) public view returns (address t) {
        t = address(registry.invoice(id).token);
        if (t == address(0)) revert UnknownInvoice();
    }

    function keyOf(uint256 id) public view returns (PoolKey memory) {
        address t = tokenOf(id);
        (address c0, address c1) = t < address(jpyc) ? (t, address(jpyc)) : (address(jpyc), t);
        return PoolKey(Currency.wrap(c0), Currency.wrap(c1), FEE, TICK_SPACING, hook);
    }

    function sqrtPriceAtFair(uint256 id) public view returns (uint160) {
        uint256 fair = registry.fairPrice(id, block.timestamp); // JPYC per invoice token, 1e18
        uint256 p01 = tokenOf(id) < address(jpyc) ? fair : 1e36 / fair;
        return uint160(Math.sqrt(Math.mulDiv(p01, 1 << 192, 1e18)));
    }

    function isPoolCreated(uint256 id) public view returns (bool) {
        (uint160 sqrtP,,,) = manager.getSlot0(keyOf(id).toId());
        return sqrtP != 0;
    }

    // ---------------------------------------------------------------- pool setup
    function createPool(uint256 id) external {
        uint160 sqrtP = sqrtPriceAtFair(id);
        manager.initialize(keyOf(id), sqrtP);
        emit PoolCreated(id, sqrtP, registry.fairPrice(id, block.timestamp));
    }

    /// @notice Post `jpycAmount` of single-sided JPYC bids from just below the current price down `depthTicks`.
    function postBids(uint256 id, uint256 jpycAmount, int24 depthTicks) external returns (uint128 liquidity) {
        PoolKey memory key = keyOf(id);
        (, int24 tick,,) = manager.getSlot0(key.toId());
        bool tokenIs0 = Currency.unwrap(key.currency0) != address(jpyc);
        int24 aligned = (tick / TICK_SPACING) * TICK_SPACING;
        int24 lower;
        int24 upper;
        if (tokenIs0) {
            upper = aligned < tick ? aligned : aligned - TICK_SPACING; // JPYC = currency1: range below price
            lower = upper - depthTicks;
        } else {
            lower = aligned > tick ? aligned : aligned + TICK_SPACING; // JPYC = currency0: range above price
            upper = lower + depthTicks;
        }
        uint160 sa = TickMath.getSqrtPriceAtTick(lower);
        uint160 sb = TickMath.getSqrtPriceAtTick(upper);
        liquidity = tokenIs0
            ? LiquidityAmounts.getLiquidityForAmount1(sa, sb, jpycAmount)
            : LiquidityAmounts.getLiquidityForAmount0(sa, sb, jpycAmount);

        Position storage pos = bids[id][msg.sender];
        if (pos.liquidity != 0) revert NoPosition(); // one ladder per investor per invoice (withdraw first)
        bids[id][msg.sender] = Position(lower, upper, liquidity);
        manager.unlock(abi.encode(Action.Modify, msg.sender, abi.encode(id, lower, upper, int256(uint256(liquidity)))));
        emit BidsPosted(id, msg.sender, lower, upper, liquidity, jpycAmount);
    }

    function withdrawBids(uint256 id) external {
        Position memory pos = bids[id][msg.sender];
        if (pos.liquidity == 0) revert NoPosition();
        delete bids[id][msg.sender];
        manager.unlock(abi.encode(Action.Modify, msg.sender, abi.encode(id, pos.lower, pos.upper, -int256(uint256(pos.liquidity)))));
        emit BidsWithdrawn(id, msg.sender, pos.liquidity);
    }

    // ---------------------------------------------------------------- trading
    /// @notice Sell invoice tokens for JPYC (supplier gets paid early).
    function sell(uint256 id, uint256 amountIn, uint256 minOut) external returns (uint256 out) {
        out = abi.decode(manager.unlock(abi.encode(Action.Swap, msg.sender, abi.encode(id, true, amountIn))), (uint256));
        if (out < minOut) revert Slippage(out, minOut);
        emit Traded(id, msg.sender, true, amountIn, out);
    }

    /// @notice Buy invoice tokens with JPYC.
    function buy(uint256 id, uint256 jpycIn, uint256 minOut) external returns (uint256 out) {
        out = abi.decode(manager.unlock(abi.encode(Action.Swap, msg.sender, abi.encode(id, false, jpycIn))), (uint256));
        if (out < minOut) revert Slippage(out, minOut);
        emit Traded(id, msg.sender, false, jpycIn, out);
    }

    // ---------------------------------------------------------------- callback
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(manager)) revert NotManager();
        (Action action, address user, bytes memory inner) = abi.decode(data, (Action, address, bytes));
        if (action == Action.Swap) {
            (uint256 id, bool sellInvoice, uint256 amountIn) = abi.decode(inner, (uint256, bool, uint256));
            return abi.encode(_swap(user, id, sellInvoice, amountIn));
        }
        (uint256 id2, int24 lower, int24 upper, int256 liqDelta) = abi.decode(inner, (uint256, int24, int24, int256));
        PoolKey memory key = keyOf(id2);
        (BalanceDelta d,) = manager.modifyLiquidity(
            key, ModifyLiquidityParams(lower, upper, liqDelta, bytes32(uint256(uint160(user)))), ""
        );
        _resolve(user, key.currency0, d.amount0());
        _resolve(user, key.currency1, d.amount1());
        return "";
    }

    function _swap(address user, uint256 id, bool sellInvoice, uint256 amountIn) internal returns (uint256 out) {
        PoolKey memory key = keyOf(id);
        bool tokenIs0 = Currency.unwrap(key.currency0) != address(jpyc);
        bool zeroForOne = sellInvoice == tokenIs0; // paying currency0?
        BalanceDelta d = manager.swap(
            key,
            SwapParams(zeroForOne, -int256(amountIn), zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1),
            ""
        );
        _resolve(user, key.currency0, d.amount0());
        _resolve(user, key.currency1, d.amount1());
        out = uint256(uint128(zeroForOne ? d.amount1() : d.amount0()));
    }

    function _resolve(address user, Currency c, int128 amount) internal {
        if (amount < 0) {
            manager.sync(c);
            IERC20(Currency.unwrap(c)).safeTransferFrom(user, address(manager), uint256(uint128(-amount)));
            manager.settle();
        } else if (amount > 0) {
            manager.take(c, user, uint256(uint128(amount)));
        }
    }

}
