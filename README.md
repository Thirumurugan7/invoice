# Tegata (手形 → JPYC on Uniswap v4)

**Tegata turns debtor-acknowledged invoices into tokens that trade on Uniswap v4 along a discount curve converging to face value at maturity, settled in JPYC, with the full receivables lifecycle run through Curvegrid MultiBaas.**

## Why now (sourced in `../research/`)
- **Paper 手形 ends.** Most banks set **2026-09-30** as the last paper issuance (~83% of institutions that set a date). Paper exchange stops on 2027-03-31. Sources: FSA 「手形・小切手機能の全面的な電子化について」; 時事 2026-09-05.
- **取適法 bans paying subcontractors with 手形 from 2026-01-01** (中小企業庁 ミラサポplus). Small suppliers lose their usual way to get paid early.
- **Factoring is opaque.** In a survey of 99 factoring firms, **38.4% don't disclose fees**; disclosed upper bounds average **11.5%**, some above 20% (PR Times, 2026-06-29).
- **The incumbent registry, でんさい (¥15.3T outstanding), doesn't set a price.** Banks discount bilaterally. Nothing on-chain found: no JPYC- or stablecoin-settled tokenized 手形 (searched 2026-09-26).

## How it works

```
 Operator (KYB, MultiBaas Cloud Wallet/HSM) ── verifyCompany ──> InvoiceRegistry <── registerInvoice ── Supplier (下請)
                                                                   │  acceptInvoice (発生記録) ── Debtor
                                                                   │  mints face-value InvoiceToken (1 token = ¥1)
                                                                   ▼
 Investor ── TegataMarket.postBids (JPYC bid ladder) ──> Uniswap v4 pool (invoice/JPYC) + MaturityCurveHook
 Supplier ── TegataMarket.sell (early cash) ───────────>      price must stay on the discount curve
 Debtor ── pay(JPYC) ──> Settled ──> holders redeem 1:1 (pay, then burn)  |  unpaid + 3d ──> Defaulted ──> pro-rata
```

### Uniswap side: `src/hook/MaturityCurveHook.sol` (満期収束フック)
Each invoice has a public **fair-value curve**:

`P(t) = 1 / (1 + rate × (maturity − t) / 365d)`

It starts at a discount and rises to 1.0 (face value) at maturity. The hook uses three callbacks:
- **`beforeInitialize`:** the pool must pair an **accepted** invoice token with JPYC, and must **start on the curve** (within the band).
- **`beforeSwap`:** the invoice must be tradable: accepted, not frozen by the operator, and **more than 1 day before maturity** (the holder set is then fixed for settlement).
- **`afterSwap`:** the post-swap price must be within **±`bandBps`** (default 2%) of `P(now)`, **or** the swap must have moved the price **toward** the curve. Suppliers can't be dumped on at a predatory discount, nobody can pump an invoice above its curve, and a pool left behind as the curve accretes can always be pulled back. It emits `CurveTrade(id, price, fair, deviation)`.

**Prior art checked:** TokiHook/Napier, YieldSwapHook and BondZero price crypto principal tokens toward par with a floating rate. **None enforces an issuer-published discount schedule on receivables.** See `../research/prior_art_ideas_4_6.md`.

### Curvegrid (RWA) side: `src/rwa/InvoiceRegistry.sol` + `multibaas/`
**The lifecycle:**
- **KYB:** an operator verifies each company by recording a hashed 法人番号.
- **Registration:** a verified supplier registers an invoice against a verified debtor. The **SHA-256 of the invoice PDF** (hashed in the browser, never uploaded) can be registered only once, so **二重譲渡 (financing the same receivable twice) is blocked**.
- **Acceptance** mints tokens equal to the face value.
- **Payment:** the debtor pays JPYC, early or at maturity.
- **Settlement:** holders **redeem 1:1**, paid first, then burned.
- **Default:** past the 3-day grace period, anyone can mark it defaulted, and holders **redeem pro-rata** of what was paid.

**MultiBaas integration** (`multibaas/`):

| Piece | What it does | MultiBaas feature |
|---|---|---|
| `link.ts` | Uploads ABIs; aliases and links the registry, hook, market and **Uniswap v4 PoolManager** with event sync from the deploy block; backfills one alias per invoice token; registers the webhook | Contracts, Addresses, event sync, Webhooks API |
| `operator.ts` | KYB verification, freeze and mark-default. **Default:** MultiBaas builds the unsigned tx (`callContractFunction`), the operator key signs locally, MultiBaas submits it (`submitSignedTransaction`). **Optional:** with `MB_HSM_ADDRESS`, a Cloud Wallet (HSM, e.g. Azure Key Vault) signs and submits (`signAndSubmit`) so the key never leaves the vault | REST API tx building, signed-tx submission, Cloud Wallets (optional) |
| `webhook-server.ts` | Verifies `X-MultiBaas-Signature` = HMAC-SHA256(secret, body ‖ timestamp). On `InvoiceRegistered` it **auto-links the new invoice token** so holder Transfer events are indexed immediately, and notifies the debtor, holders and so on | Webhooks, contract linking |
| `book.ts` + web **Book** tab | Receivables book: outstanding by debtor, maturity ladder, payments, curve trades | **Event Queries** (aggregations such as `add` grouped by id) |

## Run it
```bash
git clone --recursive https://github.com/Thirumurugan7/invoice && cd invoice   # submodules: uniswap-hooks (v4-core/periphery/OZ), forge-std
forge build && forge test                     # 20 tests: lifecycle, KYB, 二重譲渡, curve band, drift, cutoff, freeze, default, market E2E
./scripts/local-chain.sh                      # anvil :8546 at Fri 2026-09-25 10:00 JST + deploy + demo invoice #1 (¥1M, 90d, 3%) + pool + ¥600k bids
cd web && npm install && npm run dev          # http://localhost:5174 (accounts: operator, supplier さくら精工, debtor 東京モーターズ, investor)
./scripts/warp.sh 90                          # move time to maturity (the UI has buttons too)

# Curvegrid MultiBaas (needs a deployment at console.curvegrid.com)
cd multibaas && cp .env.example .env && npm install
npm run link          # register + link + sync + webhook
npm run webhook       # signed webhook receiver
npm run operator -- verify 0x... 1010001000001 "株式会社さくら精工"   # signed by the Cloud Wallet
npm run book          # receivables book from Event Queries
```

**Sepolia:**

```bash
POOL_MANAGER=0xE03A1074c86CFeDd5C142C4F04F1a1536e203543 JPYC=0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29 \
OPERATOR=<Cloud Wallet address> forge script script/Deploy.s.sol --rpc-url $SEPOLIA_RPC_URL --private-key $PK --broadcast
```

## Live on Sepolia (2026-09-26)
| Contract | Address |
|---|---|
| InvoiceRegistry | `0xcc749589c6da777E23253987D9a8acf5592F4C3d` |
| MaturityCurveHook | `0x84e5aA5cD807155BA3aC0BEaBcd1476dF3aB20C0` (flags `0x20C0`) |
| TegataMarket | `0xD30F76Bb1FA540bD5Cb39bd4f906c1D88ba0B9e3` |
| MockJPYC (demo yen) | `0xe43C092183C34B58eae69Ce7d7283d4F031C9fda` |
| Uniswap v4 PoolManager (official) | `0xE03A1074c86CFeDd5C142C4F04F1a1536e203543` |
| Invoice #1 token | `0x63BAA9d83984776aF8eB9eEBB94BBF86525c2f81` |

- **Real trade:** the supplier sold ¥100,000 face of invoice #1 for **¥98,783.96 JPYC** through the hooked v4 pool. Tx `0x98fc0f6f8132a84b9cfc826754dc2b82b2041f5fe1b3b410b34a73308bcfc2ab` emits PoolManager `Swap` and hook `CurveTrade` (30 bps from the curve).
- **MultiBaas, verified live on the Curvegrid deployment (Sepolia):**
  - ABIs registered, including bytecode.
  - Registry, hook, market, **Uniswap v4 PoolManager** and invoice tokens linked with event sync.
  - The signed webhook was delivered through a tunnel. Its HMAC was verified, and on the real `InvoiceRegistered` for invoice #2 the receiver **auto-linked `tegata_invoice_2`**.
  - `npm run book` builds the receivables book from **Event Queries**.
  - The web Book tab reads from MultiBaas: CORS origin added through the Admin API.
- **Operator via MultiBaas (verified live):** `npm run operator -- verify …` had MultiBaas build the tx, the operator key sign locally, and MultiBaas submit it. Tx `0xe631d18db038f43ec3e2e564b0beb0cbfa3e28657ddfef8f4413e8bc105c948f` verified 大阪商事株式会社 on-chain.
- **Cloud Wallet (HSM):** optional and not used in this demo, because it requires your own Azure Key Vault. In production, set `MB_HSM_ADDRESS` so the operator key never leaves the vault.

MultiBaas findings (also useful for Curvegrid feedback):
- `createContract` **requires `bin` (bytecode)**; registering an ABI alone fails with a DB not-null error.
- Event Queries return at most **50 rows per request** (51 or more gives `400 invalid request`), so `book.ts` and the web Book tab page through results with `offset`.
- `bytes32` fields come back as byte arrays.
- Both bare event names and full signatures work in `eventName`.

## Verified
**`forge test`: 20/20 passing**, including:
- The supplier sells ¥300k face 90 days early for **¥295,625** (fair value ¥297,797); an ¥800k+ dump is **rejected**.
- **Full market lifecycle:** the investor earns **¥4,375** over 90 days.
- A drifted pool accepts only swaps that move the price toward the curve.
- Trading closes 1 day before maturity; frozen invoices halt.
- Pools can't start off the curve or for unaccepted invoices.
- **二重譲渡** is blocked; KYB is enforced.
- Settlement pays 1:1; default pays pro-rata (40% recovery case).

**Local chain and browser UI:**
- The supplier's early-cash sale was confirmed.
- An ¥800,000 dump was rejected with *"PriceOffCurve — … 10000 bps from the fair value 0.99266 (band ±200 bps)"* (the hook's WrappedError decoded).
- The market table showed fair 0.99266, pool 0.98959, deviation 30 bps, yield 4.27%.
- The receivables book showed ¥1,000,000 outstanding for Tokyo Motors in the 60–90 day bucket.

**Webhook receiver:** a correctly signed payload was accepted, a forged signature got **401**, and the event handler ran.

**Not yet run against a live MultiBaas deployment:** `link.ts`, `operator.ts`, `book.ts` and the browser Event-Queries mode. They typecheck against `@curvegrid/multibaas-sdk@1.1.1` but need a deployment URL and API key. The exact `event.emitted` payload fields are read defensively and should be checked against a live payload.

## Limits
- `MockJPYC` stands in for JPYC in the demo; switch to the real JPYC on Sepolia (`0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29`) via the `JPYC` env var.
- The curve uses the invoice's own discount rate. Pricing risk is the registrar's and operator's job; the hook enforces the published schedule, it doesn't discover credit risk.
- `TegataMarket` is a demo router. In production, add Universal Router support.

## Team
_TODO_
