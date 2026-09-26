// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {InvoiceRegistry} from "../src/rwa/InvoiceRegistry.sol";
import {CreditRiskModel} from "../src/rwa/CreditRiskModel.sol";
import {CollateralVault} from "../src/rwa/CollateralVault.sol";
import {MockJPYC} from "../src/rwa/MockJPYC.sol";
import {MaturityCurveHook} from "../src/hook/MaturityCurveHook.sol";
import {TegataMarket} from "../src/periphery/TegataMarket.sol";

/// Deploys Tegata. Local:  scripts/local-chain.sh.  Sepolia:
///   POOL_MANAGER=0xE03A1074c86CFeDd5C142C4F04F1a1536e203543 JPYC=0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29 \
///   OPERATOR=<MultiBaas Cloud Wallet address> forge script script/Deploy.s.sol --rpc-url sepolia --private-key $PK --broadcast
/// Optional demo data: SUPPLIER_PK, DEBTOR_PK, INVESTOR_PK. With MockJPYC the wallets are minted yen; with real JPYC
/// they must already hold it (official Sepolia faucet 0x5Fe7943a7823f6837756e9F0f259cd93494cc5D5, sendToken).
contract Deploy is Script {
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint160 constant FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG;

    struct D {
        IPoolManager manager;
        IERC20 jpyc;
        bool mockJpyc;
        CreditRiskModel risk;
        CollateralVault vault;
        InvoiceRegistry registry;
        MaturityCurveHook hook;
        TegataMarket market;
        address operator;
        uint256 startBlock;
        uint256 demoInvoice;
    }

    function run() external {
        D memory d;
        d.startBlock = block.number;
        d.operator = vm.envOr("OPERATOR", msg.sender);

        vm.startBroadcast();
        address pm = vm.envOr("POOL_MANAGER", address(0));
        d.manager = pm == address(0) ? IPoolManager(address(new PoolManager(msg.sender))) : IPoolManager(pm);
        address j = vm.envOr("JPYC", address(0));
        d.mockJpyc = j == address(0);
        d.jpyc = d.mockJpyc ? IERC20(address(new MockJPYC(msg.sender))) : IERC20(j);
        // Registry admin = deployer; OPERATOR role also granted to the operator (e.g. MultiBaas Cloud Wallet).
        d.risk = new CreditRiskModel(msg.sender);
        d.vault = new CollateralVault(d.jpyc, d.risk, msg.sender);
        d.registry = new InvoiceRegistry(d.jpyc, d.risk, d.vault, msg.sender);
        d.risk.setRegistry(address(d.registry));
        d.risk.setVault(address(d.vault));
        d.vault.setRegistry(address(d.registry));
        // Holder policy: the Uniswap v4 PoolManager custodies pool balances, so it must be allowed to hold invoices.
        d.registry.setVenue(address(d.manager), true);
        if (d.operator != msg.sender) {
            d.registry.grantRole(d.registry.OPERATOR_ROLE(), d.operator);
            d.risk.grantRole(d.risk.OPERATOR_ROLE(), d.operator);
            d.vault.grantRole(d.vault.OPERATOR_ROLE(), d.operator);
        }
        bytes memory args = abi.encode(d.manager, d.registry, Currency.wrap(address(d.jpyc)), msg.sender);
        (address hookAddr, bytes32 salt) = HookMiner.find(CREATE2_DEPLOYER, FLAGS, type(MaturityCurveHook).creationCode, args);
        d.hook = new MaturityCurveHook{salt: salt}(d.manager, d.registry, Currency.wrap(address(d.jpyc)), msg.sender);
        require(address(d.hook) == hookAddr, "hook address mismatch");
        d.market = new TegataMarket(d.manager, d.registry, IHooks(address(d.hook)), d.jpyc);
        vm.stopBroadcast();

        _demo(d);
        _write(d);
        console2.log("risk    ", address(d.risk));
        console2.log("vault   ", address(d.vault));
        console2.log("registry", address(d.registry));
        console2.log("hook    ", address(d.hook));
        console2.log("market  ", address(d.market));
    }

    /// Demo: verify + rate companies, register + accept an invoice, create its pool, post investor bids.
    function _demo(D memory d) internal {
        uint256 sPk = vm.envOr("SUPPLIER_PK", uint256(0));
        uint256 dPk = vm.envOr("DEBTOR_PK", uint256(0));
        uint256 iPk = vm.envOr("INVESTOR_PK", uint256(0));
        if (sPk == 0 || dPk == 0 || iPk == 0) return;
        address supplier = vm.addr(sPk);
        address debtor = vm.addr(dPk);
        address investor = vm.addr(iPk);

        vm.startBroadcast();
        d.registry.verifyCompany(supplier, keccak256("corp:1010001000001"), unicode"株式会社さくら精工 (Sakura Seiko)");
        d.registry.verifyCompany(debtor, keccak256("corp:2010001000002"), unicode"東京モーターズ株式会社 (Tokyo Motors)");
        d.risk.rate(debtor, 2); // grade 2: 1% base + 2% spread = 3%
        d.registry.approveInvestor(investor, true); // investor KYC
        if (d.mockJpyc) {
            MockJPYC(address(d.jpyc)).mint(investor, 2_000_000e18);
            MockJPYC(address(d.jpyc)).mint(debtor, 5_000_000e18);
        }
        vm.stopBroadcast();
        require(d.jpyc.balanceOf(investor) >= 600_000e18, "investor needs JPYC (faucet)");

        vm.startBroadcast(sPk);
        d.demoInvoice = d.registry.registerInvoice(
            debtor, 1_000_000e18, uint64(block.timestamp + 90 days), keccak256("demo-invoice-2026-0925-001.pdf"), "SKR-2026-0925-001"
        );
        vm.stopBroadcast();

        vm.startBroadcast(dPk);
        d.registry.acceptInvoice(d.demoInvoice);
        vm.stopBroadcast();

        vm.startBroadcast(iPk);
        d.market.createPool(d.demoInvoice);
        d.jpyc.approve(address(d.market), type(uint256).max);
        d.market.postBids(d.demoInvoice, 600_000e18, 0, 150, block.timestamp + 1 hours);
        vm.stopBroadcast();
    }

    function _write(D memory d) internal {
        string memory o = "deployment";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeUint(o, "startBlock", d.startBlock);
        vm.serializeUint(o, "demoInvoice", d.demoInvoice);
        vm.serializeAddress(o, "poolManager", address(d.manager));
        vm.serializeAddress(o, "jpyc", address(d.jpyc));
        vm.serializeAddress(o, "risk", address(d.risk));
        vm.serializeAddress(o, "vault", address(d.vault));
        vm.serializeAddress(o, "registry", address(d.registry));
        vm.serializeAddress(o, "hook", address(d.hook));
        vm.serializeAddress(o, "operator", d.operator);
        string memory json = vm.serializeAddress(o, "market", address(d.market));
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), ".json"));
    }
}
