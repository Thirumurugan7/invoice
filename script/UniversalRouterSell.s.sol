// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {IV4Router} from "@uniswap/v4-periphery/src/interfaces/IV4Router.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {InvoiceRegistry} from "../src/rwa/InvoiceRegistry.sol";
import {TegataMarket} from "../src/periphery/TegataMarket.sol";

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// Sells invoice tokens for JPYC through Uniswap's official Universal Router (V4_SWAP + Permit2) on Sepolia.
///   INVOICE=1 AMOUNT=100000 MIN_OUT=98000 forge script script/UniversalRouterSell.s.sol \
///     --rpc-url $SEPOLIA_RPC_URL --private-key $SUPPLIER_PK --broadcast
contract UniversalRouterSell is Script {
    IUniversalRouter constant UR = IUniversalRouter(0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b);
    IPermit2 constant PERMIT2 = IPermit2(0x000000000022D473030F116dDEE9F6B43aC78BA3);

    function run() external {
        string memory dep = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        TegataMarket market = TegataMarket(vm.parseJsonAddress(dep, ".market"));
        address jpyc = vm.parseJsonAddress(dep, ".jpyc");
        uint256 id = vm.envOr("INVOICE", uint256(1));
        uint128 amountIn = uint128(vm.envOr("AMOUNT", uint256(100_000)) * 1e18);
        uint128 minOut = uint128(vm.envOr("MIN_OUT", uint256(98_000)) * 1e18);

        address token = market.tokenOf(id);
        PoolKey memory key = market.keyOf(id);
        bool zeroForOne = Currency.unwrap(key.currency0) == token;
        bytes memory actions = abi.encodePacked(uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL));
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(IV4Router.ExactInputSingleParams(key, zeroForOne, amountIn, minOut, ""));
        params[1] = abi.encode(Currency.wrap(token), uint256(amountIn));
        params[2] = abi.encode(Currency.wrap(jpyc), uint256(minOut));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);

        uint256 before = IERC20(jpyc).balanceOf(msg.sender);
        vm.startBroadcast();
        IERC20(token).approve(address(PERMIT2), type(uint256).max);
        PERMIT2.approve(token, address(UR), type(uint160).max, uint48(block.timestamp + 1 days));
        UR.execute(abi.encodePacked(uint8(0x10)), inputs, block.timestamp + 10 minutes); // 0x10 = V4_SWAP
        vm.stopBroadcast();
        console2.log("JPYC received (wei)", IERC20(jpyc).balanceOf(msg.sender) - before);
    }
}
