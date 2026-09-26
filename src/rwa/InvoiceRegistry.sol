// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {InvoiceToken} from "./InvoiceToken.sol";
import {CreditRiskModel} from "./CreditRiskModel.sol";
import {CollateralVault} from "./CollateralVault.sol";

/// @title InvoiceRegistry — tokenized receivables settled in JPYC (a digital replacement for paper 手形)
/// @notice Lifecycle (open access: no KYB/KYC, any wallet can take part):
///   1. Companies may set a self-declared display name (`setCompanyName`); it is not verified.
///   2. Any supplier registers an invoice against any debtor. The discount rate is not the supplier's choice: the
///      fair-value curve uses the debtor's live rate from CreditRiskModel (rating + payment history). A debtor the
///      operator has not rated is priced as the weakest grade (G5), so a downgrade or default reprices all of that
///      debtor's invoices. The invoice document hash can be registered only once, so the same receivable cannot be
///      financed twice (二重譲渡).
///   3. The debtor accepts (like でんさい 発生記録): face-value tokens are minted to the supplier. Now it is an
///      acknowledged, tradable claim priced on a discount curve that accretes to face at maturity.
///   4. The debtor pays JPYC into escrow (early or at maturity). Fully paid => Settled; holders redeem 1:1.
///   5. Not fully paid by maturity + grace => anyone can mark Defaulted; holders redeem pro-rata (recovery).
///   Redemption pays JPYC first, then burns the tokens.
///   Collateral: optional by default (the operator can require a share per grade). It lowers the debtor's rate,
///   earns interest (operator-set APR, paid from a funded reward pool), and on default is seized into the payout.
///   Invoice tokens are freely transferable.
///   Invoice details (reference number, parties, terms, live price) are on-chain: `invoiceMetadata(id)` renders
///   JSON, served by each token's `contractURI()` (ERC-7572).
contract InvoiceRegistry is AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    uint256 public constant YEAR = 365 days;
    uint256 public constant BPS = 10_000;
    uint256 public constant MIN_TENOR = 1 days;
    uint256 public constant TRADING_CUTOFF = 1 days; // trading closes 1 day before maturity (holder set fixed)
    uint256 public constant GRACE = 3 days;

    enum Status {
        None,
        Pending, // registered, awaiting debtor acceptance
        Accepted, // acknowledged by debtor; tradable
        Rejected, // disputed by debtor before acceptance
        Settled, // fully paid
        Defaulted // not fully paid by maturity + grace
    }

    struct Invoice {
        address supplier;
        address debtor;
        InvoiceToken token;
        uint256 face; // JPYC wei (18 decimals); also the token supply
        uint64 issuedAt;
        uint64 maturity;
        uint32 rateAtIssueBps; // debtor's rate when registered (informational; the curve uses the live rate)
        bool frozen; // operator fraud/dispute flag: halts trading
        Status status;
        uint256 funded; // JPYC paid in by the debtor
        uint256 redeemed; // tokens redeemed so far
        bytes32 docHash; // SHA-256 of the invoice PDF
    }

    IERC20 public immutable jpyc;
    CreditRiskModel public immutable risk;
    CollateralVault public immutable vault;
    uint256 public invoiceCount;
    mapping(uint256 => Invoice) internal _invoices;
    mapping(address => uint256) public idOfToken;
    mapping(bytes32 => uint256) public idOfDocHash;
    mapping(address => string) public companyName; // self-declared by the company (unverified)
    mapping(uint256 => string) public invoiceRef; // the supplier's invoice number, e.g. SKR-2026-0926-001
    mapping(address => uint256) public outstandingOf; // unpaid face of the debtor's pending + accepted invoices

    event CompanyNamed(address indexed company, string name);
    event InvoiceRegistered(
        uint256 indexed id,
        address indexed supplier,
        address indexed debtor,
        address token,
        uint256 face,
        uint64 maturity,
        uint32 rateAtIssueBps,
        bytes32 docHash
    );
    event InvoiceMetadata(uint256 indexed id, string ref, string supplierName, string debtorName);
    event InvoiceAccepted(uint256 indexed id, address indexed debtor, address token, uint256 face);
    event InvoiceRejected(uint256 indexed id, address indexed debtor, string reason);
    event InvoiceFrozen(uint256 indexed id, bool frozen);
    event InvoicePaid(uint256 indexed id, address indexed payer, uint256 amount, uint256 funded);
    event InvoiceSettled(uint256 indexed id, uint256 funded);
    event InvoiceDefaulted(uint256 indexed id, uint256 funded, uint256 face);
    event Redeemed(uint256 indexed id, address indexed holder, uint256 tokens, uint256 jpycPaid);

    error CollateralRequired(address debtor, uint256 required, uint256 posted);
    error InvalidTerms();
    error DuplicateInvoice(uint256 existingId);
    error NotDebtor();
    error BadStatus(Status status);
    error NotYetDefaultable(uint256 at);
    error NothingToRedeem();

    constructor(IERC20 jpyc_, CreditRiskModel risk_, CollateralVault vault_, address admin) {
        jpyc = jpyc_;
        risk = risk_;
        vault = vault_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(OPERATOR_ROLE, admin);
    }

    // ---------------------------------------------------------------- companies (self-service)
    /// @notice Set the caller's display name (shown on invoices and in their on-chain metadata). Self-declared.
    function setCompanyName(string calldata name) external {
        companyName[msg.sender] = name;
        emit CompanyNamed(msg.sender, name);
    }

    // ---------------------------------------------------------------- operator
    function setFrozen(uint256 id, bool frozen) external onlyRole(OPERATOR_ROLE) {
        _invoices[id].frozen = frozen;
        emit InvoiceFrozen(id, frozen);
    }

    // ---------------------------------------------------------------- lifecycle
    function registerInvoice(address debtor, uint256 face, uint64 maturity, bytes32 docHash, string calldata ref)
        external
        returns (uint256 id)
    {
        if (face == 0 || debtor == address(0) || debtor == msg.sender || maturity < block.timestamp + MIN_TENOR) {
            revert InvalidTerms();
        }
        if (idOfDocHash[docHash] != 0) revert DuplicateInvoice(idOfDocHash[docHash]);
        uint256 need = vault.required(debtor, face);
        if (vault.collateralOf(debtor) < need) revert CollateralRequired(debtor, need, vault.collateralOf(debtor));
        outstandingOf[debtor] += face;
        uint32 rateNow = risk.rateBps(debtor);

        id = ++invoiceCount;
        string memory n = Strings.toString(id);
        string memory r = bytes(ref).length == 0 ? string.concat("#", n) : ref;
        InvoiceToken token = new InvoiceToken(string.concat("Tegata ", r), string.concat("TGT-", n), id);
        invoiceRef[id] = r;
        _invoices[id] = Invoice({
            supplier: msg.sender,
            debtor: debtor,
            token: token,
            face: face,
            issuedAt: uint64(block.timestamp),
            maturity: maturity,
            rateAtIssueBps: rateNow,
            frozen: false,
            status: Status.Pending,
            funded: 0,
            redeemed: 0,
            docHash: docHash
        });
        idOfToken[address(token)] = id;
        idOfDocHash[docHash] = id;
        emit InvoiceRegistered(id, msg.sender, debtor, address(token), face, maturity, rateNow, docHash);
        emit InvoiceMetadata(id, r, companyName[msg.sender], companyName[debtor]);
    }

    function acceptInvoice(uint256 id) external {
        Invoice storage inv = _invoices[id];
        if (msg.sender != inv.debtor) revert NotDebtor();
        if (inv.status != Status.Pending) revert BadStatus(inv.status);
        inv.status = Status.Accepted;
        inv.token.mint(inv.supplier, inv.face);
        emit InvoiceAccepted(id, msg.sender, address(inv.token), inv.face);
    }

    function rejectInvoice(uint256 id, string calldata reason) external {
        Invoice storage inv = _invoices[id];
        if (msg.sender != inv.debtor) revert NotDebtor();
        if (inv.status != Status.Pending) revert BadStatus(inv.status);
        inv.status = Status.Rejected;
        outstandingOf[inv.debtor] -= inv.face;
        emit InvoiceRejected(id, msg.sender, reason);
    }

    /// @notice Pay JPYC toward an accepted invoice (anyone may pay, typically the debtor). Early payment allowed.
    function pay(uint256 id, uint256 amount) external {
        Invoice storage inv = _invoices[id];
        if (inv.status != Status.Accepted) revert BadStatus(inv.status);
        uint256 due = inv.face - inv.funded;
        if (amount > due) amount = due;
        jpyc.safeTransferFrom(msg.sender, address(this), amount);
        inv.funded += amount;
        outstandingOf[inv.debtor] -= amount;
        emit InvoicePaid(id, msg.sender, amount, inv.funded);
        if (inv.funded == inv.face) {
            inv.status = Status.Settled;
            risk.record(inv.debtor, block.timestamp <= inv.maturity ? CreditRiskModel.CreditEvent.OnTime : CreditRiskModel.CreditEvent.Late, id);
            emit InvoiceSettled(id, inv.funded);
        }
    }

    function markDefault(uint256 id) external {
        Invoice storage inv = _invoices[id];
        if (inv.status != Status.Accepted) revert BadStatus(inv.status);
        uint256 at = uint256(inv.maturity) + GRACE;
        if (block.timestamp < at) revert NotYetDefaultable(at);
        inv.status = Status.Defaulted;
        // Seize the debtor's collateral (up to the shortfall) into this invoice's payout, then write off the rest.
        uint256 shortfall = inv.face - inv.funded;
        uint256 seized = vault.seize(inv.debtor, id, shortfall);
        inv.funded += seized;
        outstandingOf[inv.debtor] -= shortfall;
        risk.record(inv.debtor, CreditRiskModel.CreditEvent.Default, id);
        emit InvoiceDefaulted(id, inv.funded, inv.face);
    }

    /// @notice Redeem after settlement (1:1) or default (pro-rata of funds received). Pay first, then burn.
    function redeem(uint256 id, uint256 tokens) external returns (uint256 paid) {
        Invoice storage inv = _invoices[id];
        if (inv.status != Status.Settled && inv.status != Status.Defaulted) revert BadStatus(inv.status);
        if (tokens == 0) revert NothingToRedeem();
        paid = tokens * inv.funded / inv.face;
        inv.redeemed += tokens;
        jpyc.safeTransfer(msg.sender, paid);
        inv.token.burn(msg.sender, tokens);
        emit Redeemed(id, msg.sender, tokens, paid);
    }

    // ---------------------------------------------------------------- views
    function invoice(uint256 id) external view returns (Invoice memory) {
        return _invoices[id];
    }

    /// @notice The debtor's live annual discount rate (bps) that prices this invoice.
    function rateOf(uint256 id) public view returns (uint32) {
        return risk.rateBps(_invoices[id].debtor);
    }

    /// @notice Fair value of 1 token in JPYC (1e18 = face) at `ts`: simple discount at the debtor's live rate,
    ///         accreting to face at maturity.
    function fairPrice(uint256 id, uint256 ts) public view returns (uint256) {
        Invoice storage inv = _invoices[id];
        if (ts >= inv.maturity) return 1e18;
        uint256 remaining = inv.maturity - ts;
        return 1e18 * YEAR * BPS / (YEAR * BPS + uint256(rateOf(id)) * remaining);
    }

    function isTradable(uint256 id) public view returns (bool) {
        Invoice storage inv = _invoices[id];
        return inv.status == Status.Accepted && !inv.frozen && block.timestamp + TRADING_CUTOFF < inv.maturity;
    }

    // ---------------------------------------------------------------- on-chain invoice metadata
    /// @notice JSON description of the invoice (served by InvoiceToken.contractURI). Amounts in JPY (whole yen),
    ///         price in 1e18 = face value.
    function invoiceMetadata(uint256 id) external view returns (string memory) {
        Invoice storage inv = _invoices[id];
        string memory head = string.concat(
            '{"name":"Tegata ', _esc(invoiceRef[id]), '","symbol":"TGT-', Strings.toString(id),
            '","description":"Tokenized, debtor-acknowledged invoice. 1 token = 1 JPY of face value, redeemable in JPYC at maturity.",'
        );
        string memory parties = string.concat(
            '"invoice":{"id":', Strings.toString(id), ',"ref":"', _esc(invoiceRef[id]),
            '","supplier":"', Strings.toHexString(inv.supplier), '","supplierName":"', _esc(companyName[inv.supplier]),
            '","debtor":"', Strings.toHexString(inv.debtor), '","debtorName":"', _esc(companyName[inv.debtor]), '",'
        );
        string memory terms = string.concat(
            '"faceJPY":', Strings.toString(inv.face / 1e18), ',"issuedAt":', Strings.toString(inv.issuedAt),
            ',"maturity":', Strings.toString(inv.maturity), ',"status":"', _statusName(inv.status),
            '","frozen":', inv.frozen ? "true" : "false", ',"fundedJPY":', Strings.toString(inv.funded / 1e18), ','
        );
        string memory pricing = string.concat(
            '"rateAtIssueBps":', Strings.toString(inv.rateAtIssueBps), ',"rateBps":', Strings.toString(rateOf(id)),
            ',"fairPrice1e18":', Strings.toString(fairPrice(id, block.timestamp)), ',"docHash":"',
            Strings.toHexString(uint256(inv.docHash), 32), '","token":"', Strings.toHexString(address(inv.token)), '"}}'
        );
        return string.concat(head, parties, terms, pricing);
    }

    function _statusName(Status st) internal pure returns (string memory) {
        if (st == Status.Pending) return "Pending";
        if (st == Status.Accepted) return "Accepted";
        if (st == Status.Rejected) return "Rejected";
        if (st == Status.Settled) return "Settled";
        if (st == Status.Defaulted) return "Defaulted";
        return "None";
    }

    /// @dev Escape `"` and `\` so self-declared names can't break the JSON.
    function _esc(string memory v) internal pure returns (string memory) {
        bytes memory b = bytes(v);
        uint256 extra;
        for (uint256 i; i < b.length; i++) if (b[i] == '"' || b[i] == "\\") extra++;
        if (extra == 0) return v;
        bytes memory o = new bytes(b.length + extra);
        uint256 j;
        for (uint256 i; i < b.length; i++) {
            if (b[i] == '"' || b[i] == "\\") o[j++] = "\\";
            o[j++] = b[i];
        }
        return string(o);
    }
}
