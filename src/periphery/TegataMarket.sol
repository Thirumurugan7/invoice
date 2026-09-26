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
/// @notice Router for invoice/JPYC pools guarded by MaturityCurveHook. The pools are ordinary v4 pools, so the
///         official Universal Router (V4_SWAP) works too (see test/UniversalRouterFork.t.sol); this router adds
///         invoice-aware helpers:
///   - createPool(id): initialize the pool exactly on the invoice's credit-priced discount curve;
///   - postBids(id, jpyc, offset, depth, deadline): single-sided JPYC liquidity `offset` ticks below the price and
///     `depth` ticks deep. Each call opens a new position (an NFT-less id), so an investor can build a ladder;
///   - withdrawBids(positionId, deadline): pull a position (JPYC + invoice tokens bought + fees);
///   - sell / buy (exact input) and sellExactOut / buyExactOut (exact output), all with slippage limits and deadlines.
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
        uint256 invoiceId;
        address owner;
        int24 lower;
        int24 upper;
        uint128 liquidity;
    }

    uint256 public positionCount;
    mapping(uint256 positionId => Position) public positions;
    mapping(address owner => uint256[]) internal _positionsOf;

    enum Action {
        Swap,
        Modify
    }

    event PoolCreated(uint256 indexed id, uint160 sqrtPriceX96, uint256 fairPrice);
    event BidsPosted(
        uint256 indexed id, address indexed investor, uint256 indexed positionId, int24 lower, int24 upper, uint128 liquidity, uint256 jpyc
    );
    event BidsWithdrawn(uint256 indexed id, address indexed investor, uint256 indexed positionId, uint128 liquidity);
    event Traded(uint256 indexed id, address indexed user, bool sellInvoice, uint256 amountIn, uint256 amountOut);

    error NotManager();
    error Expired(uint256 deadline);
    error Slippage(uint256 amount, uint256 limit);
    error NotOwner();
    error NoPosition();
    error UnknownInvoice();
    error BadRange();
    error NotEligible(address holder);

    /// Invoice tokens are permissioned (registry.canHold). Anyone who could end up holding them — a buyer, or an LP
    /// whose JPYC bids get filled with invoice tokens — must be eligible up front, so funds can never get stuck in a
    /// position that can't be withdrawn.
    modifier onlyEligible() {
        if (!registry.canHold(msg.sender)) revert NotEligible(msg.sender);
        _;
    }

    modifier checkDeadline(uint256 deadline) {
        if (block.timestamp > deadline) revert Expired(deadline);
        _;
    }

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

    /// @notice All position ids ever opened by `owner` (withdrawn ones have liquidity 0).
    function positionsOf(address owner) external view returns (uint256[] memory) {
        return _positionsOf[owner];
    }

    // ---------------------------------------------------------------- pool setup
    function createPool(uint256 id) external {
        uint160 sqrtP = sqrtPriceAtFair(id);
        manager.initialize(keyOf(id), sqrtP);
        emit PoolCreated(id, sqrtP, registry.fairPrice(id, block.timestamp));
    }

    /// @notice Post `jpycAmount` of single-sided JPYC bids starting `offsetTicks` below the current price (in
    ///         JPYC-per-invoice terms) and `depthTicks` deep. Returns a new position id.
    function postBids(uint256 id, uint256 jpycAmount, int24 offsetTicks, int24 depthTicks, uint256 deadline)
        external
        checkDeadline(deadline)
        onlyEligible
        returns (uint256 positionId, uint128 liquidity)
    {
        if (depthTicks <= 0 || depthTicks % TICK_SPACING != 0 || offsetTicks < 0 || offsetTicks % TICK_SPACING != 0) {
            revert BadRange();
        }
        PoolKey memory key = keyOf(id);
        (, int24 tick,,) = manager.getSlot0(key.toId());
        bool tokenIs0 = Currency.unwrap(key.currency0) != address(jpyc);
        int24 aligned = (tick / TICK_SPACING) * TICK_SPACING;
        int24 lower;
        int24 upper;
        if (tokenIs0) {
            upper = (aligned < tick ? aligned : aligned - TICK_SPACING) - offsetTicks; // JPYC = currency1: below price
            lower = upper - depthTicks;
        } else {
            lower = (aligned > tick ? aligned : aligned + TICK_SPACING) + offsetTicks; // JPYC = currency0: above price
            upper = lower + depthTicks;
        }
        uint160 sa = TickMath.getSqrtPriceAtTick(lower);
        uint160 sb = TickMath.getSqrtPriceAtTick(upper);
        liquidity = tokenIs0
            ? LiquidityAmounts.getLiquidityForAmount1(sa, sb, jpycAmount)
            : LiquidityAmounts.getLiquidityForAmount0(sa, sb, jpycAmount);

        positionId = ++positionCount;
        positions[positionId] = Position(id, msg.sender, lower, upper, liquidity);
        _positionsOf[msg.sender].push(positionId);
        manager.unlock(abi.encode(Action.Modify, msg.sender, abi.encode(id, lower, upper, int256(uint256(liquidity)), positionId)));
        emit BidsPosted(id, msg.sender, positionId, lower, upper, liquidity, jpycAmount);
    }

    function withdrawBids(uint256 positionId, uint256 deadline) external checkDeadline(deadline) {
        Position memory pos = positions[positionId];
        if (pos.owner != msg.sender) revert NotOwner();
        if (pos.liquidity == 0) revert NoPosition();
        positions[positionId].liquidity = 0;
        manager.unlock(
            abi.encode(Action.Modify, msg.sender, abi.encode(pos.invoiceId, pos.lower, pos.upper, -int256(uint256(pos.liquidity)), positionId))
        );
        emit BidsWithdrawn(pos.invoiceId, msg.sender, positionId, pos.liquidity);
    }

    // ---------------------------------------------------------------- trading
    /// @notice Sell exactly `amountIn` invoice tokens for at least `minOut` JPYC (supplier gets paid early).
    function sell(uint256 id, uint256 amountIn, uint256 minOut, uint256 deadline)
        external
        checkDeadline(deadline)
        returns (uint256 out)
    {
        (, out) = _trade(id, true, true, amountIn);
        if (out < minOut) revert Slippage(out, minOut);
        emit Traded(id, msg.sender, true, amountIn, out);
    }

    /// @notice Sell at most `maxIn` invoice tokens to receive exactly `jpycOut` JPYC.
    function sellExactOut(uint256 id, uint256 jpycOut, uint256 maxIn, uint256 deadline)
        external
        checkDeadline(deadline)
        returns (uint256 paid)
    {
        (paid,) = _trade(id, true, false, jpycOut);
        if (paid > maxIn) revert Slippage(paid, maxIn);
        emit Traded(id, msg.sender, true, paid, jpycOut);
    }

    /// @notice Spend exactly `jpycIn` JPYC for at least `minOut` invoice tokens.
    function buy(uint256 id, uint256 jpycIn, uint256 minOut, uint256 deadline)
        external
        checkDeadline(deadline)
        onlyEligible
        returns (uint256 out)
    {
        (, out) = _trade(id, false, true, jpycIn);
        if (out < minOut) revert Slippage(out, minOut);
        emit Traded(id, msg.sender, false, jpycIn, out);
    }

    /// @notice Buy exactly `tokensOut` invoice tokens for at most `maxJpycIn` JPYC.
    function buyExactOut(uint256 id, uint256 tokensOut, uint256 maxJpycIn, uint256 deadline)
        external
        checkDeadline(deadline)
        onlyEligible
        returns (uint256 paid)
    {
        (paid,) = _trade(id, false, false, tokensOut);
        if (paid > maxJpycIn) revert Slippage(paid, maxJpycIn);
        emit Traded(id, msg.sender, false, paid, tokensOut);
    }

    function _trade(uint256 id, bool sellInvoice, bool exactIn, uint256 amount) internal returns (uint256 paid, uint256 got) {
        (paid, got) = abi.decode(
            manager.unlock(abi.encode(Action.Swap, msg.sender, abi.encode(id, sellInvoice, exactIn, amount))), (uint256, uint256)
        );
    }

    // ---------------------------------------------------------------- callback
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(manager)) revert NotManager();
        (Action action, address user, bytes memory inner) = abi.decode(data, (Action, address, bytes));
        if (action == Action.Swap) {
            (uint256 id, bool sellInvoice, bool exactIn, uint256 amount) = abi.decode(inner, (uint256, bool, bool, uint256));
            return _swap(user, id, sellInvoice, exactIn, amount);
        }
        (uint256 id2, int24 lower, int24 upper, int256 liqDelta, uint256 positionId) =
            abi.decode(inner, (uint256, int24, int24, int256, uint256));
        PoolKey memory key = keyOf(id2);
        (BalanceDelta d,) = manager.modifyLiquidity(key, ModifyLiquidityParams(lower, upper, liqDelta, bytes32(positionId)), "");
        _resolve(user, key.currency0, d.amount0());
        _resolve(user, key.currency1, d.amount1());
        return "";
    }

    function _swap(address user, uint256 id, bool sellInvoice, bool exactIn, uint256 amount) internal returns (bytes memory) {
        PoolKey memory key = keyOf(id);
        bool tokenIs0 = Currency.unwrap(key.currency0) != address(jpyc);
        bool zeroForOne = sellInvoice == tokenIs0; // paying currency0?
        BalanceDelta d = manager.swap(
            key,
            SwapParams(
                zeroForOne,
                exactIn ? -int256(amount) : int256(amount),
                zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            ),
            ""
        );
        _resolve(user, key.currency0, d.amount0());
        _resolve(user, key.currency1, d.amount1());
        (int128 inD, int128 outD) = zeroForOne ? (d.amount0(), d.amount1()) : (d.amount1(), d.amount0());
        uint256 got = uint256(uint128(outD));
        // A curve-bounded pool may run out of liquidity before an exact-output amount is filled.
        if (!exactIn && got < amount) revert Slippage(got, amount);
        return abi.encode(uint256(uint128(-inD)), got);
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
