# Uniswap Developer Feedback: Tegata

## Where the integration lives
- Hook: `src/hook/MaturityCurveHook.sol`. `_beforeInitialize` checks that the pool starts on the curve, `_beforeSwap` checks tradability and stores the pre-swap deviation in transient storage, and `_afterSwap` enforces the band or the move toward the curve.
- Router: `src/periphery/TegataMarket.sol`. It handles `unlockCallback`, single-sided JPYC bid ranges via `LiquidityAmounts` + `TickMath`, and sync/settle/take.
- Tests against a real `PoolManager`: `test/Tegata.t.sol`, `test/TegataMarket.t.sol`.

## What worked well
- Checking the post-swap price in `afterSwap` (via `StateLibrary.getSlot0`) and reverting was a simple, robust way to enforce a price schedule without writing a custom curve.
- `LiquidityAmounts.getLiquidityForAmount0/1` made single-sided bid ladders easy.

## What cost us time
1. **Rounding in "did this swap improve things" checks.** Comparing deviations in whole basis points wrongly rejected small corrective swaps: 91 bp before and 91 bp after. We had to compare at 1e18 precision (`_deviationE18`). A note in the hook docs about comparing pre- and post-swap prices would help.
2. **Hook errors surface as `WrappedError`,** and PoolManager wraps them again at `beforeInitialize`. Frontends must unwrap them (`web/src/errors.ts`). A viem/SDK helper would save every team this work.
3. **`BaseHook` now lives in OpenZeppelin `uniswap-hooks`,** and its `InvalidPool()` error collides with same-named user errors. This bit us in a sibling project.
4. **Choosing tick ranges for single-sided liquidity depends on token ordering.** For "JPYC-only bids below the price", which side of the current tick the range must sit on flips with `currency0`/`currency1`. An official "place single-sided liquidity on the X side" helper would avoid a common source of bugs.

## Request
- A documented pattern for **schedule-enforcing hooks**, where the price must track an issuer-published curve or NAV, with guidance on letting drifted pools recover.
