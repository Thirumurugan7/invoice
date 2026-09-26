# Tegata (手形 → JPYC on Uniswap v4)

**Tegata turns debtor-acknowledged invoices into tokens that trade on Uniswap v4 along a discount curve converging to face value at maturity, settled in JPYC, with the full receivables lifecycle run through Curvegrid MultiBaas.**

## Why now (sourced in `../research/`)
- **Paper 手形 ends.** Most banks set **2026-09-30** as the last paper issuance (~83% of institutions that set a date). Paper exchange stops on 2027-03-31. Sources: FSA 「手形・小切手機能の全面的な電子化について」; 時事 2026-09-05.
- **取適法 bans paying subcontractors with 手形 from 2026-01-01** (中小企業庁 ミラサポplus). Small suppliers lose their usual way to get paid early.
- **Factoring is opaque.** In a survey of 99 factoring firms, **38.4% don't disclose fees**; disclosed upper bounds average **11.5%**, some above 20% (PR Times, 2026-06-29).
- **The incumbent registry, でんさい (¥15.3T outstanding), doesn't set a price.** Banks discount bilaterally. Nothing on-chain found: no JPYC- or stablecoin-settled tokenized 手形 (searched 2026-09-26).

## How it works

```
 Operator (credit rating, MultiBaas) ── rate ──> CreditRiskModel     InvoiceRegistry <── registerInvoice ── any Supplier (下請)
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
             + grade spread                    (operator credit grade: G1 1% · G2 2% · G3 4% · G4 8% · G5 16%; unrated = G5)
             + 10% × defaults                  (recorded by the registry on markDefault)
             + 1%  × late payments             (settled after maturity)
             − 0.1% × on-time settlements      (max −1%)        clamped to [base, 50%]
```

A debtor the operator hasn't rated is priced as **G5** (17%): the risk is priced into the discount, so any supplier can invoice any company. A downgrade, or a default on **any** of the debtor's invoices, reprices **every** open invoice of that debtor at once. The hook then blocks buying above the new curve and lets holders exit only toward it. The hook uses three callbacks:
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
- **Open access (no KYB/KYC):** any wallet can register, accept, pay, hold, trade and redeem invoices. Companies set their own display name (`setCompanyName`); it is self-declared and not verified.
- **Registration:** any supplier registers an invoice against any debtor. The **SHA-256 of the invoice PDF** (hashed in the browser, never uploaded) can be registered only once, so **二重譲渡 (financing the same receivable twice) is blocked**.
- **Acceptance** mints tokens equal to the face value.
- **Payment:** the debtor pays JPYC, early or at maturity. On-time or late settlement is recorded in the debtor's credit history.
- **Settlement:** holders **redeem 1:1**, paid first, then burned.
- **Default:** past the 3-day grace period, anyone can mark it defaulted, and holders **redeem pro-rata** of what was paid.
- **Debtor collateral (`src/rwa/CollateralVault.sol`):**
  - **Optional by default:** any debtor may lock JPYC; nobody is required to, so a debtor can never block a supplier from invoicing. The operator can make it mandatory per grade (`setRequiredBps`, Operator tab or `npm run operator -- require <grade> <bps>`); a debtor at that grade must then cover that share of everything it owes before a new invoice can be registered against it (`CollateralRequired`). The deploy sets every grade to 0% (`COLLATERAL_REQUIRED_BPS`).
  - **Locked collateral earns interest** at an operator-set APR (default 3%, max 20%), paid in JPYC from a reward pool the operator funds (`fundRewards`). `claimInterest` pays what the pool holds; any shortfall stays claimable. Interest is booked before every collateral change and on APR changes, so it's exact per second.
  - Coverage lowers the rate by up to **−2% at 100% coverage**.
  - Collateral can't be withdrawn below what outstanding invoices require.
  - **On default, collateral is seized automatically** (up to the shortfall) and added to what holders redeem. In the tested case, recovery rises from 30% to 50%. Interest earned before the default stays with the debtor and comes from the reward pool, never from the payout.
- **Invoice tokens are freely transferable** (plain ERC-20; mint and burn stay registry-only).
- **On-chain invoice record:** each invoice carries its reference number (請求書番号, e.g. `SKR-2026-0925-001`), which also names the token (`Tegata SKR-…`). `InvoiceToken.contractURI()` (ERC-7572) serves live JSON built by the registry: parties and company names, face value, due date, status, amount paid, rate at issue and live rate, fair price and the document fingerprint. `InvoiceMetadata` events are indexed by MultiBaas.

**MultiBaas integration** (`multibaas/`):

| Piece | What it does | MultiBaas feature |
|---|---|---|
| `link.ts` | Uploads ABIs; aliases and links the registry, hook, market and **Uniswap v4 PoolManager** with event sync from the deploy block; backfills one alias per invoice token; registers the webhook | Contracts, Addresses, event sync, Webhooks API |
| `operator.ts` | **Credit rating (`rate <debtor> <grade>`, `base <bps>`)**, **collateral APR (`apr <bps>`) and requirement (`require <grade> <bps>`)**, freeze and mark-default. Each command waits for MultiBaas to report the transaction mined (and fails loudly on a revert). **Default:** MultiBaas builds the unsigned tx (`callContractFunction`), the operator key signs locally, MultiBaas submits it (`submitSignedTransaction`). **Optional:** with `MB_HSM_ADDRESS`, a Cloud Wallet (HSM, e.g. Azure Key Vault) signs and submits (`signAndSubmit`) so the key never leaves the vault | REST API tx building, signed-tx submission, Cloud Wallets (optional) |
| `webhook-server.ts` | Verifies `X-MultiBaas-Signature` = HMAC-SHA256(secret, body ‖ timestamp). On `InvoiceRegistered` it **auto-links the new invoice token** so holder Transfer events are indexed immediately, and notifies the debtor, holders and so on | Webhooks, contract linking |
| `book.ts` + web **Book** tab | Receivables book: outstanding by debtor, maturity ladder, payments, **credit events (ratings, on-time/late/default)**, curve trades | **Event Queries** (aggregations such as `add` grouped by id) |

## Run it
```bash
git clone --recursive https://github.com/Thirumurugan7/invoice && cd invoice   # submodules: uniswap-hooks (v4-core/periphery/OZ), forge-std
forge build && forge test                     # 64 tests: lifecycle, open access, 二重譲渡, credit repricing, collateral + interest, curve band, drift, cutoff, freeze, default, router, UR fork
./scripts/local-chain.sh                      # anvil :8546 at Fri 2026-09-25 10:00 JST + deploy + demo invoice #1 (¥1M, 90d, 3%) + pool + ¥600k bids + ¥200k reward pool at 3% APR
cd web && npm install && npm run dev          # http://localhost:5174 (accounts: operator, supplier さくら精工, debtor 東京モーターズ, investor, new unrated companies A and B)
./scripts/warp.sh 90                          # move time to maturity (the UI has buttons too)

# Curvegrid MultiBaas (needs a deployment at console.curvegrid.com)
cd multibaas && cp .env.example .env && npm install
npm run link          # register + link + sync + webhook
npm run webhook       # signed webhook receiver
npm run operator -- rate 0x... 2              # rate a debtor G2 (built by MultiBaas, signed by the operator key)
npm run operator -- apr 300                   # collateral interest: 3% APR
npm run operator -- require 5 0               # mandatory collateral for G5/unrated debtors: 0 = optional (default)
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

## Live on Sepolia (2026-09-26): real JPYC, open access, collateral interest
| Contract | Address |
|---|---|
| InvoiceRegistry | `0xdDfF37Bd15C3489e5DE953CA1C10f92397DE1E71` |
| CreditRiskModel | `0xb7f45ED8846Cc6bcecFe856c04E6442130D55F4b` |
| CollateralVault | `0x3a3009DcAfBe2521B50df2dcF8A6Dff9fA7396B8` (3% APR, ¥200,000 reward pool, collateral optional for every grade) |
| MaturityCurveHook | `0x171a7D09da98a1e9fBAC208257C63E03DF6860C0` |
| TegataMarket | `0x9B8Cd3012F8c50BE91aa854A7Ebc55459c96cd44` |
| **JPYC (real, JPYC Inc. Sepolia)** | `0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29` |
| Uniswap v4 PoolManager (official) | `0xE03A1074c86CFeDd5C142C4F04F1a1536e203543` |
| Uniswap Universal Router (official) | `0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b` |
| Invoice #1 token (`Tegata SKR-2026-0925-001`) | `0xC05d084e58373fE22570e5f15C51ECbabb46e549` |

**Open-access end to end with a brand-new wallet** (no KYB, no rating, no approval), in real JPYC. This run used a 20% requirement for G5; the operator has since set every grade to 0% through MultiBaas (`npm run operator -- require 4 0` / `require 5 0`), so collateral is now optional (steps 2–3 would be skipped):
1. The new wallet named itself `新規商事株式会社 (NewCo Trading)` (`setCompanyName`); unrated, it priced as G5 (17%).
2. Sakura Seiko's ¥100,000 invoice against it reverted with `CollateralRequired(NewCo, ¥20,000, ¥0)`.
3. NewCo locked ¥20,000; registration (`NEWCO-2026-0926-001`) then succeeded at **16.60%** (20% coverage −0.4%), and NewCo accepted.
4. The investor opened the pool on the curve and posted ¥50,000 of bids; the supplier sold ¥20,000 of face early for **¥19,605.19 JPYC** (curve ¥19,731).
5. NewCo paid ¥100,000 early: **Settled**, on-time credit event, rate 17% → 14.90% (16.90% once it withdrew its collateral). The supplier redeemed ¥80,000 and the investor ¥20,000, both 1:1.
6. NewCo claimed its collateral interest from the reward pool and withdrew all its collateral. The vault then held exactly the reward pool.
7. MultiBaas indexed it all: the webhook logged `CompanyNamed`, collateral, registration, the curve trade and settlement, and auto-linked `tegata_invoice_2`; `npm run book` shows the invoice, the on-time credit event and the trade.

Earlier deployments (KYB/KYC era), superseded:
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
  - Operator actions (rating, collateral APR, freeze, default) via `callContractFunction`, signed locally, then `submitSignedTransaction`.
  - Cloud Wallet (HSM) remains optional: set `MB_HSM_ADDRESS` (it requires your own Azure Key Vault).

MultiBaas findings (also useful for Curvegrid feedback):
- `createContract` **requires `bin` (bytecode)**; registering an ABI alone fails with a DB not-null error.
- Event Queries return at most **50 rows per request** (51 or more gives `400 invalid request`), so `book.ts` and the web Book tab page through results with `offset`.
- `bytes32` fields come back as byte arrays.
- Both bare event names and full signatures work in `eventName`.

## Verified
**`forge test`: 65/65 passing** (the fork suite runs when `SEPOLIA_RPC_URL` is set), including:
- **Credit:**
  - The rate comes from the debtor; an unrated debtor is priced as G5 (17%) and follows the operator's rating once rated.
  - With the default 0% requirement an unrated debtor is invoiced at once at 17%; voluntary collateral lowers the rate (−1% at 50% coverage) and can be withdrawn freely. With a requirement set, registration waits for the collateral.
  - A downgrade reprices the pool: buys are blocked and sells are allowed.
  - A default on one invoice reprices the debtor's others (3% → 13%).
  - On-time settlement lowers the rate (2.90%); late payment raises it (4%); the rate is clamped.
- **Collateral (`test/Collateral.t.sol`):**
  - When the operator requires 20% for G5, a G5 debtor must cover it before being invoiced; G2 needs none.
  - No withdrawals below the requirement; payments reduce what's required.
  - Coverage lowers the rate (−1% at 50%, −2% at 100%, floored at the base rate).
  - On default, collateral is seized into the payout (recovery 30% → 50%); only the registry can seize.
- **Collateral interest (`test/CollateralInterest.t.sol`):**
  - 3% APR on ¥100,000 for a year pays exactly ¥3,000; deposits, withdrawals and APR changes are booked exactly.
  - A short pool pays what it holds and keeps the rest claimable; the pool can never pay out collateral.
  - Only the operator sets the APR (capped at 20%), the collateral requirement, or withdraws unused rewards.
  - On default, holders get the seized collateral in full and the debtor's earned interest comes from the pool.
- **Claims made to judges (`test/Claims.t.sol`):**
  - Any wallet can post bids or buy.
  - The supplier can sell small and large amounts; investors can exit before maturity.
  - Supply is fixed at face value; the price rises to exactly ¥1 at maturity.
  - The ¥2,000 example: ¥1,990.19 today at 3%, ¥1,945.63 after a downgrade to 17%, and the debtor still owes and pays exactly ¥2,000, redeemed 1:1.
  - Trading closes 1 day before the due date.
- **RWA:**
  - Transfers go to any wallet; an anonymous wallet can buy from the pool; any company can register and accept; names are self-declared.
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
- **二重譲渡** is blocked.
- Settlement pays 1:1; default pays pro-rata (40% recovery case).

**Local chain and browser UI:**
- The supplier's early-cash sale was confirmed.
- An ¥800,000 dump was rejected with *"PriceOffCurve — … 10000 bps from the fair value 0.99266 (band ±200 bps)"* (the hook's WrappedError decoded).
- The market table showed fair 0.99266, pool 0.98959, deviation 30 bps, yield 4.27%.
- The receivables book showed ¥1,000,000 outstanding for Tokyo Motors in the 60–90 day bucket.

**Webhook receiver:** a correctly signed payload was accepted, a forged signature got **401**, and the event handler ran.

## Limits
- **No KYB/KYC:** anyone can register invoices under any self-declared name. The protections that remain are the debtor's on-chain acceptance, the one-time document hash (二重譲渡), G5 pricing for unrated debtors (plus an optional operator-set collateral requirement), and the operator's freeze. Real KYB (NTA 法人番号 check, World ID, an HSM-signed attestation via MultiBaas) is future work.
- **Credit inputs:** grades are set by the operator (e.g. from a 帝国データバンク / 東京商工リサーチ score). The on-chain part is the pricing rule and the payment history, not the credit research itself.
- **Pool repricing:** when a debtor is downgraded, existing bid ladders are adversely selected until LPs re-post. The hook limits this to exits toward the new curve.

## Team
_TODO_
