// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseHook} from "@openzeppelin/uniswap-hooks/base/BaseHook.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {InvoiceRegistry} from "../rwa/InvoiceRegistry.sol";

/// @title MaturityCurveHook (満期収束フック)
/// @notice Uniswap v4 hook for invoice-token / JPYC pools. The registry publishes each invoice's fair-value curve
///         (face value discounted at the invoice's rate, rising to 1.0 at maturity). The hook:
///   - beforeInitialize: pool must pair an ACCEPTED invoice token with JPYC and start on the curve (within band);
///   - beforeSwap: invoice must be tradable (accepted, not frozen, before the 1-day pre-maturity cutoff);
///   - afterSwap: the post-swap price must be within `bandBps` of the curve — OR the swap must have moved the
///     price closer to the curve (so pools that drift as the curve accretes can always be pulled back).
///   Suppliers cannot be dumped on at a predatory discount, and nobody can pump an invoice above its curve.
///   Permissions: beforeInitialize | beforeSwap | afterSwap.
contract MaturityCurveHook is BaseHook {
    using StateLibrary for IPoolManager;

    InvoiceRegistry public immutable registry;
    Currency public immutable jpyc;
    address public admin;
    uint256 public bandBps = 200; // ±2% around the curve

    bytes32 private constant T_PRE_DEV = keccak256("tegata.hook.preDeviation");

    event CurveTrade(uint256 indexed invoiceId, PoolId indexed poolId, uint256 price, uint256 fair, uint256 deviationBps);
    event BandSet(uint256 bandBps);

    error NotInvoicePool();
    error InvoiceNotAccepted(uint256 id);
    error InitOffCurve(uint256 price, uint256 fair);
    error TradingClosed(uint256 id);
    error PriceOffCurve(uint256 price, uint256 fair, uint256 deviationBps, uint256 bandBps);
    error NotAdmin();

    constructor(IPoolManager manager, InvoiceRegistry registry_, Currency jpyc_, address admin_) BaseHook(manager) {
        registry = registry_;
        jpyc = jpyc_;
        admin = admin_;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    function setBandBps(uint256 band) external {
        if (msg.sender != admin) revert NotAdmin();
        bandBps = band;
        emit BandSet(band);
    }

    // ---------------------------------------------------------------- views
    /// @return id invoice id (0 if the pool is not invoice/JPYC)
    function invoiceOf(PoolKey calldata key) public view returns (uint256 id) {
        if (key.currency0 == jpyc) return registry.idOfToken(Currency.unwrap(key.currency1));
        if (key.currency1 == jpyc) return registry.idOfToken(Currency.unwrap(key.currency0));
    }

    /// @notice Price of 1 invoice token in JPYC (1e18 = face) for a given sqrtPriceX96.
    function priceFromSqrt(PoolKey calldata key, uint160 sqrtPriceX96) public view returns (uint256) {
        uint256 p01 = FullMath.mulDiv(FullMath.mulDiv(sqrtPriceX96, sqrtPriceX96, 1 << 96), 1e18, 1 << 96);
        return key.currency1 == jpyc ? p01 : FullMath.mulDiv(1e18, 1e18, p01);
    }

    function poolPrice(PoolKey calldata key) public view returns (uint256) {
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(key.toId());
        return priceFromSqrt(key, sqrtPriceX96);
    }

    function deviationBps(uint256 price, uint256 fair) public pure returns (uint256) {
        return _deviationE18(price, fair) / 1e14;
    }

    /// @dev |price - fair| / fair with 1e18 precision (used for the "moved toward the curve" comparison, where
    ///      whole-bps rounding would wrongly reject small corrective swaps).
    function _deviationE18(uint256 price, uint256 fair) internal pure returns (uint256) {
        uint256 diff = price > fair ? price - fair : fair - price;
        return FullMath.mulDiv(diff, 1e18, fair);
    }

    // ---------------------------------------------------------------- hooks
    function _beforeInitialize(address, PoolKey calldata key, uint160 sqrtPriceX96) internal view override returns (bytes4) {
        uint256 id = invoiceOf(key);
        if (id == 0) revert NotInvoicePool();
        if (registry.invoice(id).status != InvoiceRegistry.Status.Accepted) revert InvoiceNotAccepted(id);
        uint256 price = priceFromSqrt(key, sqrtPriceX96);
        uint256 fair = registry.fairPrice(id, block.timestamp);
        if (deviationBps(price, fair) > bandBps) revert InitOffCurve(price, fair);
        return this.beforeInitialize.selector;
    }

    function _beforeSwap(address, PoolKey calldata key, SwapParams calldata, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        uint256 id = invoiceOf(key);
        if (!registry.isTradable(id)) revert TradingClosed(id);
        uint256 pre = _deviationE18(poolPrice(key), registry.fairPrice(id, block.timestamp));
        bytes32 slot = T_PRE_DEV;
        assembly ("memory-safe") {
            tstore(slot, pre)
        }
        return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function _afterSwap(address, PoolKey calldata key, SwapParams calldata, BalanceDelta, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        uint256 id = invoiceOf(key);
        uint256 price = poolPrice(key);
        uint256 fair = registry.fairPrice(id, block.timestamp);
        uint256 devE18 = _deviationE18(price, fair);
        uint256 dev = devE18 / 1e14;
        uint256 pre;
        bytes32 slot = T_PRE_DEV;
        assembly ("memory-safe") {
            pre := tload(slot)
        }
        // Inside the band: fine. Outside: only allowed if this swap moved the price toward the curve.
        if (dev > bandBps && devE18 >= pre) revert PriceOffCurve(price, fair, dev, bandBps);
        emit CurveTrade(id, key.toId(), price, fair, dev);
        return (this.afterSwap.selector, 0);
    }
}
