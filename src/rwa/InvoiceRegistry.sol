// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {InvoiceToken} from "./InvoiceToken.sol";

/// @title InvoiceRegistry — tokenized receivables settled in JPYC (a digital replacement for paper 手形)
/// @notice Lifecycle:
///   1. OPERATOR (platform; a MultiBaas Cloud Wallet / HSM key) verifies companies (KYB: hashed 法人番号).
///   2. A verified supplier registers an invoice against a verified debtor. The invoice document hash can be
///      registered only once, so the same receivable cannot be financed twice (二重譲渡).
///   3. The debtor accepts (like でんさい 発生記録): face-value tokens are minted to the supplier. Now it is an
///      acknowledged, tradable claim priced on a discount curve that accretes to face at maturity.
///   4. The debtor pays JPYC into escrow (early or at maturity). Fully paid => Settled; holders redeem 1:1.
///   5. Not fully paid by maturity + grace => anyone can mark Defaulted; holders redeem pro-rata (recovery).
///   Redemption pays JPYC first, then burns the tokens.
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
        uint32 discountBps; // annual simple discount rate used for the fair-value curve
        bool frozen; // operator fraud/dispute flag: halts trading
        Status status;
        uint256 funded; // JPYC paid in by the debtor
        uint256 redeemed; // tokens redeemed so far
        bytes32 docHash; // SHA-256 of the invoice PDF
    }

    IERC20 public immutable jpyc;
    uint256 public invoiceCount;
    mapping(uint256 => Invoice) internal _invoices;
    mapping(address => uint256) public idOfToken;
    mapping(bytes32 => uint256) public idOfDocHash;
    mapping(address => bytes32) public companyIdHash; // keccak256(法人番号) of verified companies
    mapping(address => string) public companyName;

    event CompanyVerified(address indexed company, bytes32 indexed corpIdHash, string name);
    event CompanyRevoked(address indexed company);
    event InvoiceRegistered(
        uint256 indexed id,
        address indexed supplier,
        address indexed debtor,
        address token,
        uint256 face,
        uint64 maturity,
        uint32 discountBps,
        bytes32 docHash
    );
    event InvoiceAccepted(uint256 indexed id, address indexed debtor, address token, uint256 face);
    event InvoiceRejected(uint256 indexed id, address indexed debtor, string reason);
    event InvoiceFrozen(uint256 indexed id, bool frozen);
    event InvoicePaid(uint256 indexed id, address indexed payer, uint256 amount, uint256 funded);
    event InvoiceSettled(uint256 indexed id, uint256 funded);
    event InvoiceDefaulted(uint256 indexed id, uint256 funded, uint256 face);
    event Redeemed(uint256 indexed id, address indexed holder, uint256 tokens, uint256 jpycPaid);

    error NotVerified(address company);
    error InvalidTerms();
    error DuplicateInvoice(uint256 existingId);
    error NotDebtor();
    error BadStatus(Status status);
    error NotYetDefaultable(uint256 at);
    error NothingToRedeem();

    constructor(IERC20 jpyc_, address admin) {
        jpyc = jpyc_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(OPERATOR_ROLE, admin);
    }

    // ---------------------------------------------------------------- KYB (operator / Cloud Wallet)
    function verifyCompany(address company, bytes32 corpIdHash, string calldata name) external onlyRole(OPERATOR_ROLE) {
        companyIdHash[company] = corpIdHash;
        companyName[company] = name;
        emit CompanyVerified(company, corpIdHash, name);
    }

    function revokeCompany(address company) external onlyRole(OPERATOR_ROLE) {
        delete companyIdHash[company];
        emit CompanyRevoked(company);
    }

    function isVerified(address company) public view returns (bool) {
        return companyIdHash[company] != bytes32(0);
    }

    function setFrozen(uint256 id, bool frozen) external onlyRole(OPERATOR_ROLE) {
        _invoices[id].frozen = frozen;
        emit InvoiceFrozen(id, frozen);
    }

    // ---------------------------------------------------------------- lifecycle
    function registerInvoice(address debtor, uint256 face, uint64 maturity, uint32 discountBps, bytes32 docHash)
        external
        returns (uint256 id)
    {
        if (!isVerified(msg.sender)) revert NotVerified(msg.sender);
        if (!isVerified(debtor)) revert NotVerified(debtor);
        if (face == 0 || debtor == msg.sender || maturity < block.timestamp + MIN_TENOR || discountBps > 5_000) {
            revert InvalidTerms();
        }
        if (idOfDocHash[docHash] != 0) revert DuplicateInvoice(idOfDocHash[docHash]);

        id = ++invoiceCount;
        string memory n = Strings.toString(id);
        InvoiceToken token = new InvoiceToken(string.concat("Tegata Invoice #", n), string.concat("TGT-", n), id);
        _invoices[id] = Invoice({
            supplier: msg.sender,
            debtor: debtor,
            token: token,
            face: face,
            issuedAt: uint64(block.timestamp),
            maturity: maturity,
            discountBps: discountBps,
            frozen: false,
            status: Status.Pending,
            funded: 0,
            redeemed: 0,
            docHash: docHash
        });
        idOfToken[address(token)] = id;
        idOfDocHash[docHash] = id;
        emit InvoiceRegistered(id, msg.sender, debtor, address(token), face, maturity, discountBps, docHash);
    }

    function acceptInvoice(uint256 id) external {
        Invoice storage inv = _invoices[id];
        if (msg.sender != inv.debtor) revert NotDebtor();
        if (!isVerified(msg.sender)) revert NotVerified(msg.sender);
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
        emit InvoicePaid(id, msg.sender, amount, inv.funded);
        if (inv.funded == inv.face) {
            inv.status = Status.Settled;
            emit InvoiceSettled(id, inv.funded);
        }
    }

    function markDefault(uint256 id) external {
        Invoice storage inv = _invoices[id];
        if (inv.status != Status.Accepted) revert BadStatus(inv.status);
        uint256 at = uint256(inv.maturity) + GRACE;
        if (block.timestamp < at) revert NotYetDefaultable(at);
        inv.status = Status.Defaulted;
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

    /// @notice Fair value of 1 token in JPYC (1e18 = face) at `ts`: simple discount, accreting to face at maturity.
    function fairPrice(uint256 id, uint256 ts) public view returns (uint256) {
        Invoice storage inv = _invoices[id];
        if (ts >= inv.maturity) return 1e18;
        uint256 remaining = inv.maturity - ts;
        return 1e18 * YEAR * BPS / (YEAR * BPS + uint256(inv.discountBps) * remaining);
    }

    function isTradable(uint256 id) public view returns (bool) {
        Invoice storage inv = _invoices[id];
        return inv.status == Status.Accepted && !inv.frozen && block.timestamp + TRADING_CUTOFF < inv.maturity;
    }
}
