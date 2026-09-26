// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {TegataBase} from "./TegataBase.sol";
import {InvoiceRegistry} from "../src/rwa/InvoiceRegistry.sol";
import {InvoiceToken} from "../src/rwa/InvoiceToken.sol";

/// Open access: anyone can register, hold and trade invoices (no KYB/KYC). Every invoice carries its real-world
/// details on-chain (reference number, parties, terms, live price) as JSON via contractURI (ERC-7572).
contract RwaComplianceTest is TegataBase {
    address outsider = makeAddr("anonymous wallet");

    function _contains(string memory hay, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(hay);
        bytes memory n = bytes(needle);
        if (n.length > h.length) return false;
        for (uint256 i; i <= h.length - n.length; i++) {
            bool ok = true;
            for (uint256 j; j < n.length && ok; j++) ok = h[i + j] == n[j];
            if (ok) return true;
        }
        return false;
    }

    // ---------------------------------------------------------------- open access (no KYB / KYC)
    function test_transferToAnyWalletWorks() public {
        vm.prank(supplier);
        token.transfer(outsider, 1_000e18);
        assertEq(token.balanceOf(outsider), 1_000e18);
    }

    function test_anyWalletCanBuyFromPool() public {
        _sellInvoice(supplier, 100_000e18); // pool now holds invoice tokens
        jpyc.mint(outsider, 10_000e18);
        vm.prank(outsider);
        jpyc.approve(address(swapRouter), type(uint256).max);
        _buyInvoice(outsider, 1_000e18);
        assertGt(token.balanceOf(outsider), 0);
    }

    function test_companyNameIsSelfDeclared() public {
        vm.recordLogs();
        vm.prank(outsider);
        registry.setCompanyName("Outsider KK");
        assertEq(registry.companyName(outsider), "Outsider KK");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], InvoiceRegistry.CompanyNamed.selector);
        assertEq(logs[0].topics[1], bytes32(uint256(uint160(outsider))));
    }

    // ---------------------------------------------------------------- on-chain invoice details
    function test_tokenNamedAfterInvoiceRef() public view {
        assertEq(token.name(), "Tegata SKR-2026-0925-001");
        assertEq(registry.invoiceRef(invoiceId), "SKR-2026-0925-001");
    }

    function test_contractURIServesInvoiceJson() public {
        string memory uri = token.contractURI();
        emit log_string(uri);
        assertTrue(_contains(uri, "data:application/json;utf8,{"));
        assertTrue(_contains(uri, '"ref":"SKR-2026-0925-001"'));
        assertTrue(_contains(uri, unicode'"debtorName":"東京モーターズ株式会社"'));
        assertTrue(_contains(uri, '"faceJPY":1000000'));
        assertTrue(_contains(uri, '"status":"Accepted"'));
        assertTrue(_contains(uri, '"rateBps":300'));
    }

    function test_metadataIsLive() public {
        vm.startPrank(debtor);
        jpyc.approve(address(registry), FACE);
        registry.pay(invoiceId, FACE);
        vm.stopPrank();
        string memory uri = token.contractURI();
        assertTrue(_contains(uri, '"status":"Settled"'));
        assertTrue(_contains(uri, '"fundedJPY":1000000'));
    }

    function test_metadataEventAndDefaultRef() public {
        vm.recordLogs();
        vm.prank(supplier);
        uint256 id2 = registry.registerInvoice(debtor, 5_000e18, maturity, keccak256("no-ref"), "");
        assertEq(registry.invoiceRef(id2), string.concat("#", vm.toString(id2)));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == InvoiceRegistry.InvoiceMetadata.selector) {
                (string memory ref, string memory sName, string memory dName) = abi.decode(logs[i].data, (string, string, string));
                assertEq(ref, string.concat("#", vm.toString(id2)));
                assertEq(sName, unicode"株式会社さくら精工");
                assertEq(dName, unicode"東京モーターズ株式会社");
                found = true;
            }
        }
        assertTrue(found);
    }

    function test_jsonEscapesQuotes() public {
        address q = makeAddr("quoted");
        vm.prank(q);
        registry.setCompanyName('Evil "Co" \\ KK');
        vm.prank(operator);
        risk.rate(q, 2);
        vm.prank(supplier);
        uint256 id2 = registry.registerInvoice(q, 5_000e18, maturity, keccak256("q"), "Q-1");
        string memory json = registry.invoiceMetadata(id2);
        assertTrue(_contains(json, 'Evil \\"Co\\" \\\\ KK'));
    }
}
