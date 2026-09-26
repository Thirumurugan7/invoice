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
import {CreditRiskModel} from "../src/rwa/CreditRiskModel.sol";
import {CollateralVault} from "../src/rwa/CollateralVault.sol";
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
    address buyer = makeAddr("buyer");

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
        CreditRiskModel risk = new CreditRiskModel(operator);
        CollateralVault vault = new CollateralVault(jpyc, risk, operator);
        registry = new InvoiceRegistry(jpyc, risk, vault, operator);
        bytes memory args = abi.encode(manager, registry, Currency.wrap(address(jpyc)), operator);
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(MaturityCurveHook).creationCode, args);
        hook = new MaturityCurveHook{salt: salt}(manager, registry, Currency.wrap(address(jpyc)), operator);
        market = new TegataMarket(manager, registry, IHooks(address(hook)), jpyc);

        vm.startPrank(operator);
        risk.setRegistry(address(registry));
        risk.setVault(address(vault));
        vault.setRegistry(address(registry));
        risk.rate(debtor, 2); // 3%
        vm.stopPrank();
        vm.prank(supplier);
        id = registry.registerInvoice(debtor, 1_000_000e18, uint64(block.timestamp + 90 days), keccak256("pdf"), "");
        vm.prank(debtor);
        registry.acceptInvoice(id);
        token = registry.invoice(id).token;

        jpyc.mint(investor, 1_000_000e18);
        jpyc.mint(buyer, 1_000_000e18);
        vm.prank(buyer);
        jpyc.approve(address(market), type(uint256).max);
        jpyc.mint(debtor, 1_000_000e18);
        vm.prank(investor);
        jpyc.approve(address(market), type(uint256).max);
        vm.prank(supplier);
        token.approve(address(market), type(uint256).max);
    }

    function _dl() internal view returns (uint256) {
        return block.timestamp + 10 minutes;
    }

    function test_fullLifecycleThroughMarket() public {
        market.createPool(id);
        assertTrue(market.isPoolCreated(id));

        vm.prank(investor);
        (uint256 pos,) = market.postBids(id, 600_000e18, 0, 150, _dl());
        assertApproxEqAbs(jpyc.balanceOf(investor), 400_000e18, 1e18);

        vm.prank(supplier);
        uint256 cash = market.sell(id, 300_000e18, 290_000e18, _dl());
        emit log_named_decimal_uint("supplier early cash (JPYC) for 300k face", cash, 18);
        assertGt(cash, 290_000e18);

        vm.prank(investor);
        market.withdrawBids(pos, _dl());
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
        uint256 profit = jpyc.balanceOf(investor) - 1_000_000e18;
        emit log_named_decimal_uint("investor profit over 90 days (JPYC)", profit, 18);
        assertEq(jpyc.balanceOf(investor) - before, invTokens);
        assertGt(jpyc.balanceOf(investor), 1_000_000e18); // earned the discount
    }

    function _pooled() internal returns (uint256 pos) {
        market.createPool(id);
        vm.prank(investor);
        (pos,) = market.postBids(id, 600_000e18, 0, 150, _dl());
    }

    function test_marketSlippageProtection() public {
        _pooled();
        vm.prank(supplier);
        vm.expectRevert();
        market.sell(id, 100_000e18, 100_000e18, _dl()); // can't get face value before maturity
    }

    function test_deadlineEnforced() public {
        _pooled();
        uint256 dl = block.timestamp - 1;
        vm.prank(supplier);
        vm.expectRevert(abi.encodeWithSelector(TegataMarket.Expired.selector, dl));
        market.sell(id, 1_000e18, 0, dl);
    }

    function test_exactOutputBothWays() public {
        _pooled();
        // Supplier needs exactly ¥50,000 of cash today: sells just enough face.
        vm.prank(supplier);
        uint256 faceSold = market.sellExactOut(id, 50_000e18, 52_000e18, _dl());
        emit log_named_decimal_uint("face sold for exactly 50,000 JPYC", faceSold, 18);
        assertGt(faceSold, 50_000e18);
        assertEq(token.balanceOf(supplier), 1_000_000e18 - faceSold);

        // A buyer wants exactly 20,000 face of the invoice back out of the pool.
        uint256 jpycBefore = jpyc.balanceOf(buyer);
        vm.prank(buyer);
        uint256 paid = market.buyExactOut(id, 20_000e18, 20_000e18, _dl());
        assertEq(token.balanceOf(buyer), 20_000e18);
        assertEq(jpycBefore - jpyc.balanceOf(buyer), paid);
        assertLt(paid, 20_000e18); // still below face before maturity

        vm.prank(buyer);
        vm.expectRevert(); // Slippage: max input too low
        market.buyExactOut(id, 1_000e18, 900e18, _dl());
    }

    function test_multipleBidPositionsLadder() public {
        uint256 p1 = _pooled();
        vm.startPrank(investor);
        (uint256 p2,) = market.postBids(id, 100_000e18, 50, 100, _dl()); // a deeper rung
        (uint256 p3,) = market.postBids(id, 100_000e18, 0, 50, _dl());
        vm.stopPrank();
        assertEq(market.positionsOf(investor).length, 3);
        (, address owner, int24 lo2, int24 hi2,) = market.positions(p2);
        (,, int24 lo1, int24 hi1,) = market.positions(p1);
        assertEq(owner, investor);
        assertTrue(lo2 != lo1 || hi2 != hi1);

        vm.prank(supplier);
        vm.expectRevert(TegataMarket.NotOwner.selector);
        market.withdrawBids(p2, _dl());

        vm.startPrank(investor);
        market.withdrawBids(p2, _dl());
        vm.expectRevert(TegataMarket.NoPosition.selector);
        market.withdrawBids(p2, _dl());
        market.withdrawBids(p3, _dl());
        market.withdrawBids(p1, _dl());
        vm.stopPrank();
        assertApproxEqAbs(jpyc.balanceOf(investor), 1_000_000e18, 1e18);
    }
}
