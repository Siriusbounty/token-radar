# token-radar-01 entry

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Siriusbounty/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Siriusbounty/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar: `main.ts` (Node 22, standard library only) reads the
sealed DefiLlama snapshot, ranks the pre-token protocols by implied launch
value, and writes a dashboard showing the board, a detail view per protocol
with the model's own arithmetic, and a costed farm plan for each row.

## The model (radar-2)

The implied value is fitted from the snapshot's own live-token comps, at run
time — never from a hand-kept list of names:

- `log(mcap) = level[category] + 0.522 * log(TVL)`, where each category's
  level is the median of its live-token protocols' `log(mcap) - 0.522*log(TVL)`,
  shrunk toward the global intercept with weight `n / (n + 8)`.
- Growth: `+0.50` log points per +100% of 7-day TVL change (clamped to
  -60..+120%). Age: at most `+0.15` log points over three years of record.
  Both are damped priors: the fitted growth slope is an outlier artifact and
  the fitted age slope is ~0, so both are kept small and stated as such.
- Multiples compress with size: the fitted elasticity is 0.522, so a 10x
  larger TVL is worth ~3.3x the market cap, not 10x.

## Validation (held out, on the snapshot's 128 live-token comps)

- 4-fold held-out log-R²: **0.16** for radar-2 vs **0.02** for the starter
  radar-1's fixed 0.25 multiple; median |log error| **1.31** vs **1.66**.
- Walk-forward (train oldest 75%, test newest 25%) also favours the fitted
  model over the starter's fixed multiple.
- Predicting a token's market cap from TVL alone is hard — live comps span
  0.003x–400x TVL — but the fitted model is clearly better than the fixed
  multiple on every held-out split.

## The board

198 rows: all 40 watchlist protocols plus 158 early ones the watchlist does
not name, ranked by fitted value. Early rows use the watchlist's own exclusion
rule — no wrapped, staked or bridged product of a token that already trades
(WBTC, Binance staked ETH, Coinbase Bridge and the like are not launches
that do not exist yet). Live-token protocols are shown apart, at the market's
own values. Top of the board: Sentora Curator $119M, Steakhouse Financial
$119M, Gauntlet $92M implied.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <kit>/input/snapshot.json
```

Deterministic: the same snapshot always writes the same bytes, so the
grader's two runs agree. The dashboard is a static page with no network; the
page recomputes each row's implied value from the snapshot figures, so the
screenshots and the code agree.

---

<sub>Entered on [make.fun](https://make.fun/?ref=dn3tcxxh&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
