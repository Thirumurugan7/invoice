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
import {MockJPYC} from "../src/rwa/MockJPYC.sol";
import {MaturityCurveHook} from "../src/hook/MaturityCurveHook.sol";
import {TegataMarket} from "../src/periphery/TegataMarket.sol";

/// End-to-end through the user-facing TegataMarket: register -> accept -> create pool on curve -> investor bids ->
/// supplier sells for early cash -> investor withdraws (holds invoice tokens) -> debtor pays -> investor redeems.
contract TegataMarketTest is Test {
    uint160 constant FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG;

    address operator = makeAddr("operator");
    address supplier = makeAddr("supplier");
    address debtor = makeAddr("debtor");
    address investor = makeAddr("investor");

    MockJPYC jpyc;
    InvoiceRegistry registry;
    MaturityCurveHook hook;
    TegataMarket market;
    uint256 id;
    InvoiceToken token;

    function setUp() public {
        vm.warp(1_790_298_000);
        IPoolManager manager = new PoolManager(address(this));
        jpyc = new MockJPYC(address(this));
        registry = new InvoiceRegistry(jpyc, operator);
        bytes memory args = abi.encode(manager, registry, Currency.wrap(address(jpyc)), operator);
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(MaturityCurveHook).creationCode, args);
        hook = new MaturityCurveHook{salt: salt}(manager, registry, Currency.wrap(address(jpyc)), operator);
        market = new TegataMarket(manager, registry, IHooks(address(hook)), jpyc);

        vm.startPrank(operator);
        registry.verifyCompany(supplier, keccak256("corp:1"), "Sakura Seiko");
        registry.verifyCompany(debtor, keccak256("corp:2"), "Tokyo Motors");
        vm.stopPrank();
        vm.prank(supplier);
        id = registry.registerInvoice(debtor, 1_000_000e18, uint64(block.timestamp + 90 days), 300, keccak256("pdf"));
        vm.prank(debtor);
        registry.acceptInvoice(id);
        token = registry.invoice(id).token;

        jpyc.mint(investor, 1_000_000e18);
        jpyc.mint(debtor, 1_000_000e18);
        vm.prank(investor);
        jpyc.approve(address(market), type(uint256).max);
        vm.prank(supplier);
        token.approve(address(market), type(uint256).max);
    }

    function test_fullLifecycleThroughMarket() public {
        market.createPool(id);
        assertTrue(market.isPoolCreated(id));

        vm.prank(investor);
        market.postBids(id, 600_000e18, 150);
        assertApproxEqAbs(jpyc.balanceOf(investor), 400_000e18, 1e18);

        vm.prank(supplier);
        uint256 cash = market.sell(id, 300_000e18, 290_000e18);
        emit log_named_decimal_uint("supplier early cash (JPYC) for 300k face", cash, 18);
        assertGt(cash, 290_000e18);

        vm.prank(investor);
        market.withdrawBids(id);
        uint256 invTokens = token.balanceOf(investor);
        assertApproxEqAbs(invTokens, 300_000e18, 1e18);

        vm.warp(block.timestamp + 90 days);
        vm.startPrank(debtor);
        jpyc.approve(address(registry), 1_000_000e18);
        registry.pay(id, 1_000_000e18);
        vm.stopPrank();

        uint256 before = jpyc.balanceOf(investor);
        vm.prank(investor);
        registry.redeem(id, invTokens);
        uint256 profit = jpyc.balanceOf(investor) + 0 - 1_000_000e18;
        emit log_named_decimal_uint("investor profit over 90 days (JPYC)", profit, 18);
        assertEq(jpyc.balanceOf(investor) - before, invTokens);
        assertGt(jpyc.balanceOf(investor), 1_000_000e18); // earned the discount
    }

    function test_marketSlippageProtection() public {
        market.createPool(id);
        vm.prank(investor);
        market.postBids(id, 600_000e18, 150);
        vm.prank(supplier);
        vm.expectRevert();
        market.sell(id, 100_000e18, 100_000e18); // can't get face value before maturity
    }
}
