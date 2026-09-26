// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {IV4Router} from "@uniswap/v4-periphery/src/interfaces/IV4Router.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {InvoiceRegistry} from "../src/rwa/InvoiceRegistry.sol";
import {InvoiceToken} from "../src/rwa/InvoiceToken.sol";
import {CreditRiskModel} from "../src/rwa/CreditRiskModel.sol";
import {CollateralVault} from "../src/rwa/CollateralVault.sol";
import {MaturityCurveHook} from "../src/hook/MaturityCurveHook.sol";
import {TegataMarket} from "../src/periphery/TegataMarket.sol";

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// Sepolia fork: official Uniswap v4 PoolManager, official Universal Router + Permit2, real JPYC.
/// Proves invoice pools are ordinary v4 pools any Uniswap front end/aggregator can route through, and that the
/// MaturityCurveHook still enforces the credit-priced curve whichever router is used.
///   SEPOLIA_RPC_URL=... forge test --match-contract UniversalRouterFork -vv
contract UniversalRouterForkTest is Test {
    IPoolManager constant PM = IPoolManager(0xE03A1074c86CFeDd5C142C4F04F1a1536e203543);
    IUniversalRouter constant UR = IUniversalRouter(0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b);
    IPermit2 constant PERMIT2 = IPermit2(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    IERC20 constant JPYC = IERC20(0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29);
    address constant JPYC_FAUCET = 0x5Fe7943a7823f6837756e9F0f259cd93494cc5D5;
    uint8 constant V4_SWAP = 0x10;
    uint160 constant FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG;

    address operator = makeAddr("operator");
    address supplier = makeAddr("supplier");
    address debtor = makeAddr("debtor");
    address investor = makeAddr("investor");

    InvoiceRegistry registry;
    TegataMarket market;
    InvoiceToken token;
    uint256 id;
    bool forked;

    function setUp() public {
        string memory rpc = vm.envOr("SEPOLIA_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;

        CreditRiskModel risk = new CreditRiskModel(operator);
        CollateralVault vault = new CollateralVault(JPYC, risk, operator);
        registry = new InvoiceRegistry(JPYC, risk, vault, operator);
        bytes memory args = abi.encode(PM, registry, Currency.wrap(address(JPYC)), operator);
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(MaturityCurveHook).creationCode, args);
        MaturityCurveHook hook = new MaturityCurveHook{salt: salt}(PM, registry, Currency.wrap(address(JPYC)), operator);
        market = new TegataMarket(PM, registry, IHooks(address(hook)), JPYC);

        vm.startPrank(operator);
        risk.setRegistry(address(registry));
        risk.setVault(address(vault));
        vault.setRegistry(address(registry));
        risk.rate(debtor, 2);
        vm.stopPrank();
        vm.prank(supplier);
        id = registry.registerInvoice(debtor, 1_000_000e18, uint64(block.timestamp + 90 days), keccak256("ur-fork"), "");
        vm.prank(debtor);
        registry.acceptInvoice(id);
        token = registry.invoice(id).token;

        vm.prank(JPYC_FAUCET); // real JPYC from the official Sepolia faucet's balance
        JPYC.transfer(investor, 1_000_000e18);
        market.createPool(id);
        vm.startPrank(investor);
        JPYC.approve(address(market), type(uint256).max);
        market.postBids(id, 600_000e18, 0, 150, block.timestamp + 1 hours);
        vm.stopPrank();

        // Standard Permit2 approval flow, exactly what the Uniswap interface does.
        vm.startPrank(supplier);
        token.approve(address(PERMIT2), type(uint256).max);
        PERMIT2.approve(address(token), address(UR), type(uint160).max, uint48(block.timestamp + 1 days));
        vm.stopPrank();
    }

    function _urSell(uint128 amountIn, uint128 minOut, bool expectFail) internal {
        PoolKey memory key = market.keyOf(id);
        bool zeroForOne = Currency.unwrap(key.currency0) == address(token);
        bytes memory actions = abi.encodePacked(uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL));
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(IV4Router.ExactInputSingleParams(key, zeroForOne, amountIn, minOut, ""));
        params[1] = abi.encode(Currency.wrap(address(token)), uint256(amountIn));
        params[2] = abi.encode(Currency.wrap(address(JPYC)), uint256(minOut));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
        vm.prank(supplier);
        if (expectFail) vm.expectRevert(); // PriceOffCurve wrapped by the PoolManager, bubbled up by the router
        UR.execute(abi.encodePacked(V4_SWAP), inputs, block.timestamp + 10 minutes);
    }

    function test_sellInvoiceThroughOfficialUniversalRouter() public {
        if (!forked) return vm.skip(true);
        uint256 before = JPYC.balanceOf(supplier);
        _urSell(100_000e18, 98_000e18, false);
        uint256 cash = JPYC.balanceOf(supplier) - before;
        emit log_named_decimal_uint("real JPYC received via Universal Router for 100k face", cash, 18);
        assertGt(cash, 98_000e18);
        assertEq(token.balanceOf(supplier), 900_000e18);
    }

    function test_hookStillBlocksDumpThroughUniversalRouter() public {
        if (!forked) return vm.skip(true);
        _urSell(900_000e18, 0, true);
        assertEq(token.balanceOf(supplier), 1_000_000e18);
    }
}
