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

### Uniswap side: `src/hook/MaturityCurveHook.sol` (満期収束フック) + `src/periphery/TegataMarket.sol`
Each invoice has a public **fair-value curve**:

`P(t) = 1 / (1 + rate(debtor) × (maturity − t) / 365d)`

It starts at a discount and rises to 1.0 (face value) at maturity. **The rate is not the supplier's choice.** It is the debtor's live credit rate from `src/rwa/CreditRiskModel.sol`:

```
rate(debtor) = base rate                      (operator: funding cost)
             + grade spread                    (operator KYB/credit grade: G1 1% · G2 2% · G3 4% · G4 8% · G5 16%)
             + 10% × defaults                  (recorded by the registry on markDefault)
             + 1%  × late payments             (settled after maturity)
             − 0.1% × on-time settlements      (max −1%)        clamped to [base, 50%]
```

The registry refuses invoices against unrated debtors. A downgrade, or a default on **any** of the debtor's invoices, reprices **every** open invoice of that debtor at once. The hook then blocks buying above the new curve and lets holders exit only toward it. The hook uses three callbacks:
- **`beforeInitialize`:** the pool must pair an **accepted** invoice token with JPYC, and must **start on the curve** (within the band).
- **`beforeSwap`:** the invoice must be tradable: accepted, not frozen by the operator, and **more than 1 day before maturity** (the holder set is then fixed for settlement).
- **`afterSwap`:** the post-swap price must be within **±`bandBps`** (default 2%) of `P(now)`, **or** the swap must have moved the price **toward** the curve. Suppliers can't be dumped on at a predatory discount, nobody can pump an invoice above its curve, and a pool left behind as the curve accretes can always be pulled back. It emits `CurveTrade(id, price, fair, deviation)`.

**Routing.** Invoice pools are ordinary v4 pools, so **Uniswap's official Universal Router (V4_SWAP + Permit2) works as is**. This is proven by the Sepolia fork test `test/UniversalRouterFork.t.sol` and by a live Sepolia swap (below). The hook enforces the curve whichever router is used. `TegataMarket` adds invoice-aware helpers:
- `createPool` on the curve.
- `postBids(id, jpyc, offset, depth, deadline)`: each call opens a **new position**, so an investor can build a bid ladder; `withdrawBids(positionId, deadline)` closes one.
- `sell`/`buy` (exact input) and `sellExactOut`/`buyExactOut` (exact output), all with **slippage limits and deadlines**.

**Prior art checked:** TokiHook/Napier, YieldSwapHook and BondZero price crypto principal tokens toward par with a floating rate. **None enforces an issuer-published discount schedule on receivables.** See `../research/prior_art_ideas_4_6.md`.

### Curvegrid (RWA) side: `src/rwa/InvoiceRegistry.sol` + `multibaas/`
**The lifecycle:**
- **KYB:** an operator verifies each company by recording a hashed 法人番号.
- **Registration:** a verified supplier registers an invoice against a verified debtor. The **SHA-256 of the invoice PDF** (hashed in the browser, never uploaded) can be registered only once, so **二重譲渡 (financing the same receivable twice) is blocked**.
- **Acceptance** mints tokens equal to the face value.
- **Payment:** the debtor pays JPYC, early or at maturity. On-time or late settlement is recorded in the debtor's credit history.
- **Settlement:** holders **redeem 1:1**, paid first, then burned.
- **Default:** past the 3-day grace period, anyone can mark it defaulted, and holders **redeem pro-rata** of what was paid.
- **Debtor collateral (`src/rwa/CollateralVault.sol`):**
  - Weak debtors (**G4–G5**) must lock JPYC covering **20% of everything they owe** before a new invoice can be registered against them (`CollateralRequired`). G1–G3 debtors may lock collateral voluntarily.
  - Coverage lowers the rate by up to **−2% at 100% coverage**.
  - Collateral can't be withdrawn below what outstanding invoices require.
  - **On default, collateral is seized automatically** (up to the shortfall) and added to what holders redeem. In the tested case, recovery rises from 30% to 50%.
- **Permissioned holders (ERC-3643 style):** every invoice-token transfer checks `registry.canHold(to)`. Only KYB-verified companies, operator-approved investors (`approveInvestor`) and approved venues (the Uniswap v4 PoolManager, via `setVenue`) can receive invoices. An anonymous wallet can't buy, receive or withdraw into invoice exposure. Revoked investors keep what they already hold and can still redeem, because redemption burns tokens instead of transferring them.
- **On-chain invoice record:** each invoice carries its reference number (請求書番号, e.g. `SKR-2026-0925-001`), which also names the token (`Tegata SKR-…`). `InvoiceToken.contractURI()` (ERC-7572) serves live JSON built by the registry: parties and company names, face value, due date, status, amount paid, rate at issue and live rate, fair price and the document fingerprint. `InvoiceMetadata` events are indexed by MultiBaas.

**MultiBaas integration** (`multibaas/`):

| Piece | What it does | MultiBaas feature |
|---|---|---|
| `link.ts` | Uploads ABIs; aliases and links the registry, hook, market and **Uniswap v4 PoolManager** with event sync from the deploy block; backfills one alias per invoice token; registers the webhook | Contracts, Addresses, event sync, Webhooks API |
| `operator.ts` | KYB verification, **investor KYC (`approve-investor`, `venue`)**, **credit rating (`rate <debtor> <grade>`, `base <bps>`)**, freeze and mark-default. **Default:** MultiBaas builds the unsigned tx (`callContractFunction`), the operator key signs locally, MultiBaas submits it (`submitSignedTransaction`). **Optional:** with `MB_HSM_ADDRESS`, a Cloud Wallet (HSM, e.g. Azure Key Vault) signs and submits (`signAndSubmit`) so the key never leaves the vault | REST API tx building, signed-tx submission, Cloud Wallets (optional) |
| `webhook-server.ts` | Verifies `X-MultiBaas-Signature` = HMAC-SHA256(secret, body ‖ timestamp). On `InvoiceRegistered` it **auto-links the new invoice token** so holder Transfer events are indexed immediately, and notifies the debtor, holders and so on | Webhooks, contract linking |
| `book.ts` + web **Book** tab | Receivables book: outstanding by debtor, maturity ladder, payments, **credit events (ratings, on-time/late/default)**, curve trades | **Event Queries** (aggregations such as `add` grouped by id) |

## Run it
```bash
git clone --recursive https://github.com/Thirumurugan7/invoice && cd invoice   # submodules: uniswap-hooks (v4-core/periphery/OZ), forge-std
forge build && forge test                     # 33 tests: lifecycle, KYB, 二重譲渡, credit repricing, curve band, drift, cutoff, freeze, default, router, UR fork
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

**Sepolia (real JPYC):**

```bash
# 1. Fund the demo wallets with real JPYC from the official faucet (≤3M per claim, once per 24h, balance ≤1M)
cast send 0x5Fe7943a7823f6837756e9F0f259cd93494cc5D5 "sendToken(address,uint256)" $WALLET 3000000000000000000000000 --private-key $WALLET_PK
# 2. Deploy (+ demo invoice if SUPPLIER_PK/DEBTOR_PK/INVESTOR_PK are set)
POOL_MANAGER=0xE03A1074c86CFeDd5C142C4F04F1a1536e203543 JPYC=0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29 \
OPERATOR=<operator address> forge script script/Deploy.s.sol --rpc-url $SEPOLIA_RPC_URL --private-key $PK --broadcast
# 3. Sell through Uniswap's official Universal Router
forge script script/UniversalRouterSell.s.sol --rpc-url $SEPOLIA_RPC_URL --private-key $SUPPLIER_PK --broadcast
# Fork test against the real PoolManager, Universal Router, Permit2 and JPYC
SEPOLIA_RPC_URL=... forge test --match-contract UniversalRouterFork -vv
```

## Live on Sepolia (2026-09-26): real JPYC, permissioned invoices, debtor collateral
| Contract | Address |
|---|---|
| InvoiceRegistry | `0x89d0463141A64f2F2C8ac5917e35689146fbC359` |
| CreditRiskModel | `0xEF6d77c01FafC37a056bbA7FD3e5E5Aa66ACF08D` |
| CollateralVault | `0xc3F291581F84cD0Da0ae54fc6137DA95bB40C875` |
| MaturityCurveHook | `0x4613b7968940d0c39ff0ceb695f153FbE23020c0` (flags `0x20C0`) |
| TegataMarket | `0xf58C4a3F878533f3Cd028630f448E47F4CE9083A` |
| **JPYC (real, JPYC Inc. Sepolia)** | `0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29` |
| Uniswap v4 PoolManager (official, approved venue) | `0xE03A1074c86CFeDd5C142C4F04F1a1536e203543` |
| Uniswap Universal Router (official) | `0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b` |
| Invoice #1 token (`Tegata SKR-2026-0925-001`) | `0x4690dA0C29b8B462Daa34ab05CfE888c02099Ce8` |

- **Collateral live:**
  1. The operator downgraded Tokyo Motors to G5 through MultiBaas.
  2. A ¥100,000 invoice reverted with `CollateralRequired(debtor, ¥220,000, ¥0)`, i.e. 20% of ¥1.1M.
  3. The debtor locked ¥220,000; registration then succeeded, and 20% coverage cut the rate from 17.00% to 16.60%.
  4. The webhook logged `[collateral] … locked 220000 JPYC`.
  5. Cleanup: the debtor rejected the test invoice, was rated back to G2, and withdrew the collateral.

Earlier checks, on the previous deployment, still hold for this code:
- **RWA controls live:**
  - A transfer to an unapproved wallet reverts with `NotEligible(0x1111…)`.
  - Investor approval runs through MultiBaas (`npm run operator -- approve-investor`), and the webhook logs `[rwa] investor … approved (KYC)`.
  - The token's `contractURI()` returns the invoice's JSON record.
  - `TegataMarket` refuses bids and buys from unapproved wallets (`NotEligible`), so LP funds can't get stuck in a position that would deliver invoice tokens to an ineligible wallet.
  - Live market sell: ¥10,000 of face for ¥9,879 of JPYC, tx `0xc982d7ad…e1e3`. Investor early exit (sold ¥5,000 back), tx `0x6b0331bf…0f5f`.
  - A Universal Router sell still works under the holder policy: ¥10,000 of face sold for ¥9,889 of JPYC, tx `0x0658047f6f5633414086641b91c5aed05dee7f6e85e07a52cc2a5b11d18d48ba`.

Earlier deployment (before the holder policy):
- **Real JPYC:** the demo wallets were funded from JPYC's official Sepolia faucet (`0x5Fe7…c5D5`). No mock token is involved.
- **Universal Router swap:** the supplier sold ¥100,000 face of invoice #1 for **¥98,783.96 real JPYC** through Uniswap's **official Universal Router** (V4_SWAP + Permit2). Tx `0x943826882ea1376466ea414a9faed12f94e7e179a688bcd1ccb13a67a9acbee6` emits PoolManager `Swap`, hook `CurveTrade` and the JPYC `Transfer`.
- **Credit repricing through MultiBaas:** `npm run operator -- rate <debtor> 3` (MultiBaas builds, the operator signs, MultiBaas submits) moved the debtor's rate from 3% to 5%. Invoice #1's fair value fell from 0.99266 to 0.98782; re-rating to G2 restored it.
  - Paying invoice #2 early from the browser recorded an **on-time settlement**, which lowered the rate to **2.90%** and raised invoice #1's fair value to 0.99290 automatically.
  - All of these credit events are indexed by MultiBaas Event Queries (Book tab, `npm run book`), and the signed webhook logged each one.
- **Browser end to end:**
  - Register (the rate comes from the debtor) → accept → early pay → on-time credit event.
  - Two bid positions on one invoice, then a buy (deviation 33 → 20 bps), then withdrawal of one position.
  - The webhook auto-linked `tegata_invoice_2`, re-pointing the alias away from the superseded deployment.
- **MultiBaas:**
  - ABIs v2.0 registered, including the new `tegata_credit_risk`.
  - Registry, credit model, hook, market, PoolManager and invoice tokens linked with event sync.
  - Aliases re-pointed automatically on redeploy.
  - Operator actions (KYB, rating, freeze, default) via `callContractFunction`, signed locally, then `submitSignedTransaction`.
  - Cloud Wallet (HSM) remains optional: set `MB_HSM_ADDRESS` (it requires your own Azure Key Vault).

MultiBaas findings (also useful for Curvegrid feedback):
- `createContract` **requires `bin` (bytecode)**; registering an ABI alone fails with a DB not-null error.
- Event Queries return at most **50 rows per request** (51 or more gives `400 invalid request`), so `book.ts` and the web Book tab page through results with `offset`.
- `bytes32` fields come back as byte arrays.
- Both bare event names and full signatures work in `eventName`.

## Verified
**`forge test`: 58/58 passing** (the fork suite runs when `SEPOLIA_RPC_URL` is set), including:
- **Credit:**
  - The rate comes from the debtor; unrated debtors are refused.
  - A downgrade reprices the pool: buys are blocked and sells are allowed.
  - A default on one invoice reprices the debtor's others (3% → 13%).
  - On-time settlement lowers the rate (2.90%); late payment raises it (4%); the rate is clamped.
- **Collateral (`test/Collateral.t.sol`):**
  - G5 needs 20% of outstanding and G2 needs none.
  - No withdrawals below the requirement; payments reduce what's required.
  - Coverage lowers the rate (−1% at 50%, −2% at 100%, floored at the base rate).
  - On default, collateral is seized into the payout (recovery 30% → 50%); only the registry can seize.
- **Claims made to judges (`test/Claims.t.sol`):**
  - Only approved investors can post bids or buy; unapproved wallets are stopped before any funds move.
  - The supplier can sell small and large amounts; investors can exit before maturity.
  - Supply is fixed at face value; the price rises to exactly ¥1 at maturity.
  - The ¥2,000 example: ¥1,990.19 today at 3%, ¥1,945.63 after a downgrade to 17%, and the debtor still owes and pays exactly ¥2,000, redeemed 1:1.
  - Trading closes 1 day before the due date.
- **RWA:**
  - Transfers only to eligible holders; an anonymous wallet can't buy from the pool until the operator approves it.
  - Revocation blocks new receipts but keeps holdings redeemable; only the operator manages the policy.
  - The token is named after the invoice number; `contractURI` serves live JSON (status and amount paid update on payment); the `InvoiceMetadata` event is indexed; the JSON is escaped.
- **Router:**
  - Deadlines, exact-output sells and buys, max-in slippage.
  - A multi-position bid ladder with owner checks.
  - **Official Universal Router on a Sepolia fork:** a sell with real JPYC succeeds; a dump through the same router is blocked by the hook.
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

## Limits
- **Credit inputs:** grades are set by the operator (e.g. from a 帝国データバンク / 東京商工リサーチ score). The on-chain part is the pricing rule and the payment history, not the credit research itself.
- **Pool repricing:** when a debtor is downgraded, existing bid ladders are adversely selected until LPs re-post. The hook limits this to exits toward the new curve.

## Team
_TODO_
