# MBI/XP Breadth Methodology

The versioned breadth engine is data-only. It independently reconstructs the
publicly described MBI-style calculations from Dhan/ScanX data and does not use
or attempt to recover protected Pine source.

## Universe

The `mbi-xp-v2.2` universe is a dated latest-snapshot universe:

- NSE equity rows from `customscan/fetchdt`
- latest price greater than or equal to `1`
- market capitalization strictly greater than `100` crore
- valid symbol, ISIN, and Dhan security ID

The ₹100 crore threshold is calibrated against the published table. It
reproduces the independently displayed 10-, 20-, and 50-session breadth
percentages substantially better than the previous ₹999 crore assumption.

The full inclusion/exclusion audit is written to
`breadth_universe_snapshot.json.gz`. Historical results use this fixed universe,
so they intentionally have current-universe survivorship bias. A future
point-in-time universe requires historical NSE security membership and daily
market capitalization.

## Raw Inputs

- `dhan_data_response.json`: current universe, price, market cap, identity
- `ohlcv_data/{SYMBOL}.csv`: adjusted daily equity OHLCV cache
- `indices_ohlcv_data/NIFTY.csv`: reference index history
- `breadth_methodology.json`: pinned calculation policy

The OHLCV fetcher keeps approximately four calendar years by default and can be
overridden with `EDL_OHLCV_HISTORY_DAYS`. It backfills older gaps as well as
updating newer gaps.

## Per-stock Calculations

```text
daily_return = 100 * (close / previous_valid_close - 1)
SMA(n) = rolling arithmetic mean of n closes
EMA(n) = recursive EMA with alpha = 2 / (n + 1), adjust=False
```

Periods are `10`, `20`, `50`, and `200`.

Advance/decline boundaries:

```text
up_4     = daily_return >= 4
down_4   = daily_return < -4
up_4_5   = daily_return >= 4.5
down_4_5 = daily_return < -4.5
```

New extrema are strict comparisons against the prior window; the current day is
not part of the reference:

```text
new_high(n) = high_today > maximum(high over prior n sessions)
new_low(n)  = low_today < minimum(low over prior n sessions)
```

The engine calculates 21-session monthly, 63-session quarterly, and 252-session
52-week extrema.

## Cross-sectional Calculations

Displayed percentages use each metric's valid population. A newly listed stock
without 200 bars is excluded from the 200-day SMA percentage rather than
counted as below the average. Raw valid counts remain in every row for audit.

```text
percent_above_n = 100 * above_n / valid_sma_n
4% / 4.5% pct   = 100 * threshold_count / valid_return
new-high/low pct = 100 * new_high_or_low / valid_extrema_window
4R              = 100 * up_4 / down_4
4.5R            = 100 * up_4_5 / down_4_5
20R             = 100 * above_20 / (valid_sma_20 - above_20)
50R             = 100 * above_50 / (valid_sma_50 - above_50)
4.5 change       = 100 * (4.5R_today / 4.5R_previous - 1)
NNH              = new_highs - new_lows
```

A zero denominator produces `null`, never an invented neutral ratio.

The selected default MA is SMA. Both SMA and EMA counts and denominators remain
in the artifact, so the methodology can be switched without refetching history.

## MBI State

```text
4.5R:  green > 200, red < 50
20R:   green > 75,  red < 50
50R:   green > 85,  red < 60
change cells: green > 20, red < -20
NNH: green when highs > lows, red when highs < lows
```

The implementation treats NNH as one comparison cell because the protected
script does not disclose separate scoring for the displayed high and low
columns.

```text
score = green_cells - red_cells
green day: score >= 3
red day: score <= -3
neutral: otherwise
warning day: at least 3 red cells while overall state is not red
```

## XP

The implementation uses the publicly disclosed recurrence:

```text
advancers_t = raw count of stocks with daily_return >= 4.5
decliners_t = raw count of stocks with daily_return < -4.5
z_t = 0.162 * advancers_t + 0.838 * z_(t-1)

ln(XP_t) =
    0.592 * ln(XP_(t-1))
  + 0.471 * ln(z_t)
  + 0.198 * ln(p10 / (100 - p10))
  + 0.334
  - 0.067 * ln(decliners_t)
  - 0.077 * ln(p20 / (100 - p20))
```

`p10` and `p20` are cross-sectional percentages. The advancer and decliner
inputs are raw counts, as explicitly disclosed in the public XP formula image.
The separately retained `up_4_5_pct` and `down_4_5_pct` fields are table
diagnostics and are not XP inputs.

Undisclosed initialization and zero handling are pinned explicitly:

- initial XP: `12`
- positive-input epsilon: `0.5`
- percentage epsilon: `0.01`
- the smoothed advance series warms up even before MA percentages are available

The artifact retains the recurrence result as `xp_raw`. The displayed `xp`
applies a `0.03136` output multiplier:

```text
xp = xp_raw * 0.03136
```

This is an explicit source-calibration layer, not part of the publicly
disclosed recurrence. The scale difference indicates that the private Pine
Seed source uses an undisclosed universe normalization or recursive state. With
the current Dhan/ScanX universe it reduces the 15–28 July 2026 reference MAE
from `250.798` to `0.295` points and reproduces all 10 published integer XP
values after rounding. The unconstrained least-squares multiplier is
`0.03161798`; the interval that reproduces all 10 displayed integers is
`[0.03111302, 0.03136967]`. `0.03136` is the five-decimal constrained choice
inside that interval. It must be revalidated on unseen dates and whenever the
upstream universe changes.

Initialization, source normalization, historical constituent membership, and
zero handling remain reconstruction assumptions and may differ from the
protected script.

## EM

The protected indicator describes EM as its Pine Seed score. No public formula
or raw seed series has been found. The pipeline keeps the `em` field explicitly
set to `null`; fitting a numeric rule to ten displayed integers would be an
unvalidated proxy rather than a reconstruction.

## Outputs

- `market_breadth_v2.json.gz`: methodology, table schema, quality report, and
  250 daily rows
- `breadth_universe_snapshot.json.gz`: exact included and excluded securities
- `all_indices_history_v2.json.gz`: current snapshot plus up to 250 normalized
  OHLCV and daily-return rows for every index returned by the NSE index scan
- `market_breadth.json.gz`: unchanged legacy breadth artifact

The table schema maps the published fields directly to the labels visible in
the reference indicator: `4.5R`, `XP`, `4.5Chg`, `20R(s)`, `20Chg`, `50R(s)`,
`50Chg`, `52WH`, `52WL`, `4.5+`, `4.5-`, `10+`, `20+`, `50+`, `200+`, and
`Index`. `EM` is present as a documented unavailable/null field because its
private source series and formula have not been published.

The `Index` field in each breadth row remains the default NIFTY daily change,
matching a single selected benchmark in the indicator. Consumers that need a
different benchmark can join the row date to `all_indices_history_v2.json.gz`
by index symbol and date without rerunning breadth calculations.

Run only the new generator after the universe and OHLCV caches exist:

```powershell
python process_mbi_market_breadth.py
```

The full runner executes it during Phase 4 and validates both new artifacts
before returning success.
