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

**MultiBaas integration** (`multibaas/`):

| Piece | What it does | MultiBaas feature |
|---|---|---|
| `link.ts` | Uploads ABIs; aliases and links the registry, hook, market and **Uniswap v4 PoolManager** with event sync from the deploy block; backfills one alias per invoice token; registers the webhook | Contracts, Addresses, event sync, Webhooks API |
| `operator.ts` | KYB verification, **credit rating (`rate <debtor> <grade>`, `base <bps>`)**, freeze and mark-default. **Default:** MultiBaas builds the unsigned tx (`callContractFunction`), the operator key signs locally, MultiBaas submits it (`submitSignedTransaction`). **Optional:** with `MB_HSM_ADDRESS`, a Cloud Wallet (HSM, e.g. Azure Key Vault) signs and submits (`signAndSubmit`) so the key never leaves the vault | REST API tx building, signed-tx submission, Cloud Wallets (optional) |
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

## Live on Sepolia (2026-09-26): real JPYC
| Contract | Address |
|---|---|
| InvoiceRegistry | `0x818176Ff68F5D7Ac8c1D8027fAF90BC0C0a5A876` |
| CreditRiskModel | `0x0f8AB97b8139E589E82cB62Fec9a4709D9e62EeA` |
| MaturityCurveHook | `0xd78901189f5e205f13437902a5aeb4C7809Ae0C0` (flags `0x20C0`) |
| TegataMarket | `0xDCd16d38817314948432282c057D17662E5C5C24` |
| **JPYC (real, JPYC Inc. Sepolia)** | `0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29` |
| Uniswap v4 PoolManager (official) | `0xE03A1074c86CFeDd5C142C4F04F1a1536e203543` |
| Uniswap Universal Router (official) | `0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b` |
| Invoice #1 token | `0x6d3dBEaF508dD16A7B0b961cd0F336CdfF3d5107` |

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
**`forge test`: 33/33 passing** (the fork suite runs when `SEPOLIA_RPC_URL` is set), including:
- **Credit:**
  - The rate comes from the debtor; unrated debtors are refused.
  - A downgrade reprices the pool: buys are blocked and sells are allowed.
  - A default on one invoice reprices the debtor's others (3% → 13%).
  - On-time settlement lowers the rate (2.90%); late payment raises it (4%); the rate is clamped.
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
