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

A debtor the operator hasn't rated is priced as **G5** (17%). Any supplier can invoice any company; an unrated debtor must lock 20% collateral before it can accept. A downgrade, or a default on **any** of the debtor's invoices, reprices **every** open invoice of that debtor at once. The hook then blocks buying above the new curve and lets holders exit only toward it. The hook uses three callbacks:
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
- **Open access (no KYB/KYC):** any wallet can register, accept, pay, hold, trade and redeem invoices. Companies set their own display name (`setCompanyName`). Names are **unique** (exact match; `NameTaken`) but self-declared; the operator can take one down (`clearCompanyName`), and the app marks every company the operator hasn't rated as **unverified**.
- **Registration:** any supplier registers an invoice against any debtor; it is never blocked by the debtor. Face value is capped at ¥1 trillion. The **SHA-256 of the invoice PDF** (hashed in the browser, never uploaded) can be registered once per supplier and debtor, so **二重譲渡 (financing the same receivable twice) is blocked**. The key includes the supplier, so front-running someone's document hash doesn't block their invoice, and a rejected invoice frees its document so a corrected one can be registered.
- **Outstanding = accepted, unpaid face only.** Pending invoices don't count, so strangers' spam can't block a debtor, raise its collateral requirement or move its rate.
- **Acceptance** mints tokens equal to the face value.
- **Payment:** the debtor pays JPYC, early or at maturity. On-time or late settlement is recorded in the debtor's credit history.
- **Settlement:** holders **redeem 1:1**, paid first, then burned.
- **Default:** past the 3-day grace period, anyone can mark it defaulted, and holders **redeem pro-rata** of what was paid.
- **Debtor collateral (`src/rwa/CollateralVault.sol`):**
  - **Required at acceptance, not registration:** an **unrated** debtor must hold collateral covering **20%** of everything it will owe before it can accept an invoice (`CollateralRequired`). Rated grades default to 0% (optional). The operator sets both per grade, index 0 = unrated (`setRequiredBps`, Operator tab or `npm run operator -- require <grade> <bps>`; deploy: `UNRATED_COLLATERAL_BPS`, `COLLATERAL_REQUIRED_BPS`).
  - **Locked until paid:** collateral backing the debtor's accepted, unpaid invoices can't be withdrawn (`lockedOf`); only the excess can. A debtor can't take its collateral out before a default.
  - **Interest on backing collateral only** at an operator-set APR (default 3%, max 20%): it accrues on min(collateral, outstanding), so parking JPYC without invoices earns nothing. Paid in JPYC from a reward pool the operator funds (`fundRewards`); `claimInterest` pays what the pool holds and any shortfall stays claimable. Booked exactly per second across deposits, payments, defaults and APR changes.
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

## AI operations desk (Claude Code)
The dashboard's AI operations desk runs the operator's own logged-in **Claude Code** (`claude` CLI; no API key needed) behind the Vite dev server (`web/vite.config.ts`):
- **Live on-chain tools.** A read-only MCP server (`web/agent/tegata-mcp.mjs`) gives Claude four tools that read the contracts the app is using: `get_overview`, `list_invoices`, `get_invoice` (including the on-chain `contractURI` record), and `get_company` (rating, rate, payment history, collateral locked or free, interest, invoices). There is no signer, so it can't send transactions. Role-aware prepared actions still go to the user's wallet for approval.
- **Streaming and memory.** Replies stream to the browser as server-sent events, with a live "Reading invoices from the chain…" indicator. Each conversation is a Claude Code session resumed with `--resume`, so follow-ups keep context. **Clear history** starts a new one.
- **Boxed in.** Built-in tools are off (`--tools ""`: no file reads, no shell). Only the Tegata MCP server is loaded (`--strict-mcp-config`, so none of your other MCP servers or claude.ai connectors). Only its tools are allowed (`--allowedTools mcp__tegata`, `--permission-mode dontAsk`). It runs in an empty working directory with no project settings or CLAUDE.md; GPT (Codex CLI) and Gemini CLI also run there, never in the repo (which holds `.env`).
- **This machine only.** The dev server is also exposed through ngrok for World ID Selfie Check, so `/api/agents/*` rejects any request with a non-local `Host` or forwarding headers: nobody on the tunnel can use your Claude subscription.

Open the app at `http://localhost:5174`: the MultiBaas CORS allow-list has `localhost`, not `127.0.0.1`.

## Run it
```bash
git clone --recursive https://github.com/Thirumurugan7/invoice && cd invoice   # submodules: uniswap-hooks (v4-core/periphery/OZ), forge-std
forge build && forge test                     # 94 tests: lifecycle, open access, 二重譲渡, credit repricing, collateral + interest, adversarial edge cases, curve band, drift, cutoff, freeze, default, router, UR fork
./scripts/local-chain.sh                      # anvil :8546 at Fri 2026-09-25 10:00 JST + deploy + demo invoice #1 (¥1M, 90d, 3%) + pool + ¥600k bids + ¥200k reward pool at 3% APR
cd web && npm install && npm run dev          # http://localhost:5174 (accounts: operator, supplier さくら精工, debtor 東京モーターズ, investor, new unrated companies A and B)
./scripts/warp.sh 90                          # move time to maturity (the UI has buttons too)

# Curvegrid MultiBaas (needs a deployment at console.curvegrid.com)
cd multibaas && cp .env.example .env && npm install
npm run link          # register + link + sync + webhook
npm run webhook       # signed webhook receiver
npm run operator -- rate 0x... 2              # rate a debtor G2 (built by MultiBaas, signed by the operator key)
npm run operator -- apr 300                   # collateral interest: 3% APR
npm run operator -- require 0 2000            # collateral an UNRATED debtor needs to accept: 20% (default); 1..5 = rated grades
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

## Live on Sepolia (2026-09-26): real JPYC, open access, collateral at acceptance
| Contract | Address |
|---|---|
| InvoiceRegistry | `0x3Ae8E6b8b203581105c55f24482C81Bb58DDea97` |
| CreditRiskModel | `0x9F70536df28432485b10F12d561815460ae7f88b` |
| CollateralVault | `0x4014a110a8D42090E96Fa7Ba6407cA8084Fea88e` (unrated 20% to accept, rated 0%; 3% APR on backing collateral; ¥200,000 reward pool) |
| MaturityCurveHook | `0x5722D7c368302f6536249A6FBfa452FDcbbc20C0` |
| TegataMarket | `0xfF2c48f6496Bb0Af3f95460CF9cdbA4656992dC3` |
| **JPYC (real, JPYC Inc. Sepolia)** | `0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29` |
| Uniswap v4 PoolManager (official) | `0xE03A1074c86CFeDd5C142C4F04F1a1536e203543` |
| Uniswap Universal Router (official) | `0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b` |
| Invoice #1 token (`Tegata SKR-2026-0925-001`) | `0xd3B13b141d50C4bf2C244Ac7164175Cb8d881E41` |

**Security fixes verified against these contracts** (local fork of Sepolia, impersonated accounts): an exact-name takeover of Tokyo Motors reverts `NameTaken`; an unrated sybil can't accept without collateral (`CollateralRequired`); a 2^256−1 face reverts `InvalidTerms`; three ¥1 trillion pending invoices leave Tokyo Motors' outstanding (¥1M) and rate (3%) unchanged and its next legit invoice still registers and is accepted; front-running a document hash doesn't block the real invoice; collateral backing an accepted invoice can't be withdrawn (`BelowRequired`); ¥1M of parked JPYC earns 0 after a year while ¥200k of backing collateral earns ¥6,000.

**Real run with a brand-new unrated wallet:** Sakura Seiko registered ¥50,000 against it with no collateral (`NEWCO-2026-0926-002`); accepting needed ¥10,000 (20%), which NewCo locked; the collateral stayed locked until NewCo paid; after payment it withdrew everything, the supplier redeemed ¥50,000 1:1, token supply went to 0 and the vault held exactly the reward pool.

Previous open-access deployment (before the security fixes), superseded: registry `0xdDfF37Bd…1E71`. There, a brand-new wallet ran the whole lifecycle in real JPYC: named itself, locked collateral, got invoiced at 16.60%, the supplier sold ¥20,000 of face early for ¥19,605.19, the debtor paid early (Settled, on-time credit event), holders redeemed 1:1, and MultiBaas indexed every step.

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
**`forge test`: 94/94 passing** (the fork suite runs when `SEPOLIA_RPC_URL` is set), including:
- **Credit:**
  - The rate comes from the debtor; an unrated debtor is priced as G5 (17%) and follows the operator's rating once rated.
  - Anyone can invoice an unrated debtor; to accept it must first lock 20%. With that requirement switched off it accepts at once at 17%; voluntary collateral lowers the rate (−1% at 50% coverage) and stays locked until paid.
  - A downgrade reprices the pool: buys are blocked and sells are allowed.
  - A default on one invoice reprices the debtor's others (3% → 13%).
  - On-time settlement lowers the rate (2.90%); late payment raises it (4%); the rate is clamped.
- **Collateral (`test/Collateral.t.sol`):**
  - Unrated debtors need 20% to accept (and 20% of the new total for each further invoice); rated grades need nothing unless the operator sets it.
  - Collateral backing accepted invoices is locked until paid; payments unlock it; only the excess is free; pending invoices don't count.
  - Coverage lowers the rate (−1% at 50%, −2% at 100%, floored at the base rate).
  - On default, collateral is seized into the payout (recovery 30% → 50%); only the registry can seize.
- **Collateral interest (`test/CollateralInterest.t.sol`):**
  - 3% APR on ¥200,000 of backing collateral for a year pays exactly ¥6,000; parked collateral earns nothing; collateral above what's owed earns nothing; deposits, payments and APR changes are booked exactly.
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
  - Transfers go to any wallet; an anonymous wallet can buy from the pool; any company can register and accept; names are unique but self-declared.
- **Adversarial (`test/EdgeCases.t.sol`):** `FIXED` = attacks that now fail (exact-name takeover, pending-invoice spam blocking or repricing a debtor, doc-hash front-running, withdrawing collateral before default, draining the reward pool with parked JPYC, re-registering a corrected invoice); `RESIDUAL` = still possible (see Limits); `HOLDS` = access control, redemption, payment caps, the curve band, bid ownership, vault solvency.
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
- **No KYB/KYC, so self-dealing fraud is limited, not prevented.** One person with two wallets can invoice itself, lock the required 20%, accept, sell the tokens and never pay. Holders then recover the seized 20%; in the test the fraudster still nets about ¥376k on a ¥1M invoice while the buyer recovers 20%. Look-alike names (e.g. a trailing space) also pass the uniqueness check; the app's "unverified" label is the only warning. Real KYB (NTA 法人番号 check, World ID, an HSM-signed attestation via MultiBaas) is future work.
- **Medium, not yet fixed** (`test_RESIDUAL_*`): on-time credit can be farmed with dust self-invoices; a defaulter resets its history with a new wallet; the curve is only enforced in the Tegata pool (tokens can trade anywhere else at any price); a newline in a name breaks the metadata JSON; a debtor can't pay after an invoice is marked defaulted.
- **Credit inputs:** grades are set by the operator (e.g. from a 帝国データバンク / 東京商工リサーチ score). The on-chain part is the pricing rule and the payment history, not the credit research itself.
- **Pool repricing:** when a debtor is downgraded, existing bid ladders are adversely selected until LPs re-post. The hook limits this to exits toward the new curve.

## Team
_TODO_
