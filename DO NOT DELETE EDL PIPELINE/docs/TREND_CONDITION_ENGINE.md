# Daily trend-condition engine

`screen_trend_conditions.py` evaluates the published expression tree against the local
daily `ohlcv_data/*.csv` cache. It is deliberately local and reproducible: it
does not make a network request while screening.

```bash
python3 screen_trend_conditions.py \
  --request examples/trend-screen-request.json \
  --output output/trend-screen.json
```

## Named preset library

The scanner ships a versioned (`v1.0.39`), offline copy of 45 preset definitions. Each has
its stable `lib-*` ID, display metadata, human-readable rules, and nested
AND/OR expression. They are local data, not a runtime scrape.

```bash
python3 screen_trend_conditions.py --list-presets
python3 screen_trend_conditions.py --preset lib-horizontal-resistance \
  --output output/horizontal-resistance.json
```

A saved request can also specify `{ "preset": "lib-vcp" }`. Output carries
the selected preset's ID, rules, category, and horizon for auditability. The
public bundle supplies composition and defaults, but not private server
algorithms for complex primitives. Nexus evaluates those deterministically
under the contracts below.

Use `--list-conditions` to obtain the machine-readable registry of supported
controls. Supported daily-OHLCV conditions are:

- `persistent_momentum`
- `price_vs_ema`
- `ema_shakeout_reclaim`
- `adx`
- `price_vs_sma`
- `percent_days_above_ma`
- `ma_stack`
- `ma_slope`
- `price_change_percent`
- `consecutive_up_days`
- `gap_up` and `gap_down`
- `relative_volume`
- `volume_trend`
- `highest_volume`
- `delivery_percent_spike`
- `new_high` and `new_low`
- `percent_from_52w_high` and `percent_from_52w_low`
- `consolidation_range`
- `atr_percent`
- `range_contraction`
- `inside_bar`
- `unfilled_gap`
- `vcp_contraction_legs`
- `horizontal_resistance_line`
- `relative_strength`, `rs_new_high`, and `rs_rating`
- `market_cap`, `free_float_market_cap`, `pe_ratio`, `earnings_growth`, and
  `days_since_earnings`
- `sector`, `industry`, `average_turnover`, `adr_percent`, `price_range`,
  `price_band`, `circuit_band_minimum`, `series`, `listing_age_days`, and
  `index_membership`
- `market_breadth` and `fno_ban`

## Calculation contract

- Conditions are evaluated on daily OHLCV through `as_of_date`; if omitted,
  the most recent session in each symbol's cache is used.
- A legacy flat `conditions` list is ANDed. An `expression` can use nested
  `AND`/`OR` groups (up to any practical depth). Unknown inputs propagate only
  where they affect the result: `match OR unavailable` is a match, while
  `no_match OR unavailable` remains unavailable.
- A missing required moving-average or ADX warm-up returns `unavailable`, not
  `match` or `no_match`.
- `indicator_compare` uses one shared indicator library for price transforms,
  SMA/EMA/WMA, volume/OBV, RSI, MACD, stochastic, CCI, Williams %R, MFI, ROC,
  ADX/DI, ATR, Supertrend, Bollinger Bands and Donchian Channels. `above` and
  `below` include equality. A crossover requires strict separation on the
  signal bar and accepts equality on the preceding bar. Offsets and
  `fired_within` are trading-session counts.
- `ma_convergence` is
  `100 × (highest selected average − lowest selected average) / close`.
  Exact equality is expressed with a zero tolerance; the UI default is 1.5%.
- Supertrend uses Wilder ATR, the configured period and multiplier, carried
  final bands, and switches direction only when close crosses the opposite
  band. Both line value and direction are calculated; the condition filters
  direction state or a recent direction turn.
- Divergence pairs unique, confirmed price and oscillator fractal pivots.
  Both pivots must have their configured right-side confirmation by the
  event date, preventing future-bar leakage. Regular/hidden and
  bullish/bearish variants remain separate inputs; optional invalidation
  rejects a setup if price breaks the second pivot before confirmation.
- EMA uses `adjust=False`; ADX uses Wilder smoothing (`alpha = 1 / period`).
- `price_vs_ema` and `persistent_momentum` default to `extreme_reset`, following
  the published reset description. A contrary close arms its low
  for an above-run or high for a below-run. Only a later session trading beyond
  that extreme resets the run; equality does not reset it. The armed extreme
  survives beyond the requested trailing window. SMA retains `strict_close`.
  Explicit `strict_close` and the older `reclaim_by_extreme` mode remain available.
  Private calculations and exact remote match lists are not verified.
- `ema_shakeout_reclaim` requires a current close above the EMA plus a low-side
  or close-side dip in the requested recent window.
- `fired_within` is counted in trading sessions, including the latest session:
  `1` means the signal must be present today; `2` also accepts yesterday.
- Relative volume compares a day's volume with the *preceding* `average_window`
  sessions, avoiding look-ahead bias. Volume trend compares the most recent
  window with the immediately preceding base window.
- `delivery_percent_spike` reads the official `delivery_history_data/` cache
  first. The full pipeline maintains the newest 260 published NSE sessions
  there; the weekly EOD2 bootstrap fills older missing dates from its existing
  `DLV_QTY` fields in `eod2_delivery_history_data/`. Official NSE records take
  precedence and neither source is read unless a delivery rule is present.
- `new_high` and `new_low` compare a session's high/low with its completed
  rolling lookback. Their `fired_within` behaves identically to other recent
  signal controls: one means the latest session only.
- The 52-week distance rules use the latest 252 sessions and the session
  high/low, not the close-only return. For a stock listed less than 252
  sessions ago, the complete post-listing history is used. A high-distance of
  5 means the latest close is 5% below that window's highest high; a
  low-distance of 5 means it is 5% above its lowest low.
- `consolidation_range` is `(max(high) - min(low)) / final_close * 100` over
  the base. `exclude_latest` removes that many latest sessions before the base
  is selected, allowing a breakout session to be tested outside its base.
- `atr_percent` is Wilder ATR (`alpha = 1 / period`) divided by latest close.
- `range_contraction` compares the literal high-to-low widths of a recent and
  base window. `prior_mode: "prior"` uses the immediately preceding, disjoint base;
  `nested` uses an enclosing base and is normally the weaker test.
- `inside_bar` evaluates the latest requested run of daily bars, or ISO-week
  OHLCV bars for `timeframe: "weekly"`. Weekly mode defaults to `completed`,
  which excludes the current ISO week. `current` includes it and marks the
  result provisional because it can change before the week closes.
- `unfilled_gap` defines a gap relative to the prior close. An up-gap fills
  when a later low reaches that prior close; a down-gap fills when a later high
  reaches it. `state` selects `unfilled` or `filled` events.
- `vcp_contraction_legs` uses a deterministic close-reversal zig-zag to find
  high/low pivots, then tests the latest alternating swing legs for progressively
  smaller percentage moves. `minimum_swing_percent` is the reversal/noise floor.
- `horizontal_resistance_line` starts with the newest swing-high pivot not
  exceeded by any later **close** (wicks do not break it). Older unbroken swing
  highs within the ceiling tolerance are clustered into the same line. The
  base age/depth and price-to-line/20-EMA constraints are then applied.

### Legacy field-name compatibility

The machine-readable registry uses the pipeline's snake_case names. The
evaluator also accepts the corresponding visible legacy keys where they
differ, such as `lookbackDays`, `withinDays`, `maxRangePct`, `recentDays`,
`priorMode`, `minGapPct`, `minLegs`, and `clusterTolerancePct`. This permits a
saved UI rule to be translated without silently changing its parameters.

The generated output includes each condition's result and details. By default
only matches are emitted; use `include_non_matches` in the request or
`--include-non-matches` for diagnostics.

### Text query contract

The frontend sends query text unchanged to `scanner.query.compile_query`. The
compiler preserves parentheses, repeated clauses, and nested `AND`/`OR`
groups. It maps `>`, `>=`, `<`, `<=`, and `=` to distinct comparisons; no
opposite price bound is invented. An unsupported field or function rejects
the complete query instead of running the supported subset.

Labels containing parentheses, including P/E, EPS, dividend yield, and volume
in lakhs, are recognized as fields before function-call parsing. Public
functions include RS Rating, VCP Legs, Delivery Pct, Days Since Earnings,
Supertrend, MA Convergence, Indicator Compare, and the supported oscillators.
Availability is reported from the selected immutable snapshot and aligned
history during evaluation; the client does not infer availability from a date.

## Snapshot and cross-symbol conditions

The full refresh now also publishes `rs_rating_daily.json.gz` and
`nse_fno_ban.json.gz`. They are part of the same promoted dataset as the stock
snapshot, rather than optional files left in a local worktree.

- `relative_strength` and `rs_new_high` align stock and benchmark sessions
  before calculating their relative-strength line. They never compare unequal
  calendar windows.
- `rs_rating` is a 1–99 cross-sectional percentile across the breadth-eligible
  universe. It publishes Nifty 500-relative `one_month`, `three_month`,
  `six_month`, and `twelve_month` ratings for 21, 63, 126, and 252 sessions,
  respectively. It also publishes `front_weighted`, combining those same
  relative price ratios with weights of 40%, 20%, 20%, and 20%. Only symbols
  with at least 260 sessions aligned to the current Nifty 500 session enter
  the ranking; missing a rating means unavailable history, never a low score.
  Its artifact must have the exact same `as_of_date` as the screen, otherwise
  it is `unavailable`; a current rank is never reused for an historical screen.
- Snapshot fundamentals use the canonical stock artifact. PBT is retained
  alongside revenue, net profit and EPS when the upstream quarterly response
  supplies it. The selected report type cannot be inferred from the current
  upstream snapshot, so a report-type-specific request is not treated as a
  separate audited value.
- Market cap and free-float cap are reconstructable on a historical screen:
  the selected close is multiplied by the current implied share count
  (`current market cap / current close`), matching the bundle's documented
  price-scaled approach. P/E, reported earnings growth, sector/industry,
  circuit band, and current index membership are not reconstructed from a
  future snapshot; they return `unavailable` unless their snapshot date is the
  selected screen date.
- `average_turnover` supports daily turnover. One-, three-, and five-minute
  turnover options return `unavailable` until an intraday turnover history is
  collected.
- `series` uses the NSE `EQUITY_L` listing series, falling back to the latest
  NSE delivery-series field where necessary. Index membership is only as
  complete and current as the upstream membership snapshot; absent membership
  is `unavailable`, never a negative result.
- `market_breadth` currently publishes the all-active breadth universe. Other
  requested universes return `unavailable` until their membership datasets are
  published. The all-active result is also date-aligned; it is not reused for
  an earlier screen date.
- `fno_ban` reads NSE's official security-ban CSV. Its CSV heading determines
  `trade_date` (not the daily-report index date). A retrieval failure is
  published as `available: false`, causing the rule to return `unavailable`
  rather than wrongly treating every security as unbanned. It is also
  `unavailable` for a screen date other than that report's trade date; the
  current list is never back-applied to historical screens.

## Universes and historical snapshots

The request can use `scanUniverse`/`scan_universe` of `UNIVERSE`, `NIFTY50`,
`MIDSMALL400`, or `NIFTY500`, or supply an explicit `symbols` list. Named
universes are resolved from the membership values stored for the selected
session; a missing historical membership is never inferred.

Use `asOfFrom` plus `asOfTo` (or CLI `--as-of-from` and `--as-of-to`) for a
range screen. The CLI returns a separate result for every cached NIFTY trading
session, avoiding an undocumented interpretation of a condition over a range.

Every full refresh writes a compact, date-keyed `scanner_history_data/*.json.gz`
snapshot containing only fields used by context conditions: fundamentals,
sector/industry, price bands, index memberships, the breadth row, and the
official F&O ban row. The directory is an incremental cache, retained by the
scheduled workflow but not committed to Git. It makes historical screens
correct going forward; it cannot manufacture an older point-in-time snapshot
that was never collected.

## Reference-screen audits

`audit_scanner_reference.py` compares a dated, user-supplied symbol list with
the local evaluator using the same date, context snapshot and full delivery
history cache as a normal screen. It reports both directions of the difference
and a Jaccard score; it never contacts or impersonates another screener.

```json
{
  "as_of_date": "2026-09-25",
  "screens": {
    "lib-persistent-momentum": ["ABC", "XYZ"]
  }
}
```

```bash
python audit_scanner_reference.py --reference reference.json --output audit.json
```

For a parity claim, the reference must contain all **45** preset IDs captured
on one as-of session. The audit then needs `all_presets_exact: true`; a partial
reference can only establish `all_supplied_exact`. Use the strict mode in CI or
release validation so an incomplete or mismatched capture fails explicitly:

```bash
python audit_scanner_reference.py \
  --reference all-45-reference.json \
  --output parity-audit.json \
  --require-full-exact-match
```

The source result capture must also use the same intended equity universe and
the same completed NSE session. A different universe, stale bar, corporate
action adjustment, or private pattern implementation is a real output
difference—not proof that either evaluator is defective.

Treat exact matches as a regression check for deterministic rules and treat
pattern/relative-strength comparisons as calibration evidence. A reference
list alone cannot reveal another service's private OHLCV revisions, benchmark
adjustments, membership universe, or pattern evaluator.
