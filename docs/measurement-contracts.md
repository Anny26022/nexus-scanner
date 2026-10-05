# Measurement contracts — base engine version 3

These are distinct measurements. They must not be substituted for one another
when reproducing a scan. The metric catalog and Python/TypeScript formula paths
expose these facts; detailed context and base slices remain in private packs.

## Overhead context

`base.overheadPriceDistancePct` is `(highest historical close at candidate
creation / pivot - 1) * 100`, floored at zero. `base.overheadPct` remains its
compatibility alias. It describes a price distance, not a volume distribution.

`base.overheadCloseVolume252Pct` adds a separate daily-bar proxy: total share
volume on sessions closing strictly above the pivot, divided by total share
volume over the 252 sessions ending at the measured base end, times 100. It is
unavailable with fewer than 252 sessions or zero total volume. The historical
price-distance proxy and this fixed-window measure have different horizons.

This is **not volume traded at prices above the pivot**: daily OHLCV does not
locate transactions within the candle. True volume-at-price requires intraday
trades or a supplied price-bucket volume profile. No fabricated distribution is
published. Both base measurements freeze before the breakout candle.

## ATR and ADR

True range is `max(high-low, abs(high-previous close), abs(low-previous close))`.
The first session uses high-low. `WILDER_EWM_FIRST_TR` uses alpha `1/period`,
`adjust=False`, first-TR initialization and a full-period warmup. It differs
from an ATR initialized by an initial SMA. The browser publisher now reuses the
shared Python implementation instead of its former, inconsistent SMA seed.

| Fact | Calculation |
| --- | --- |
| `current/selection.atrWilder14Pct` | Wilder ATR14 / session close × 100 |
| `current/selection.atrSimple14Pct` | Rolling mean of 14 true ranges / close × 100 |
| `base.parts.<part>.atrWilderPct` | Mean daily Wilder ATR% within the part |
| `base.parts.<part>.atrSimplePct` | Mean daily simple-mean ATR% within the part |
| `base.parts.<part>.atrPct` | Compatibility alias for the Wilder measure |
| `base.atrContraction` | Second-half / first-half Wilder ATR% means |
| `base.atrSimpleContraction` | Second-half / first-half simple ATR% means |
| `current/selection.adrClose14Pct` | Mean 14-session `(high-low)/close × 100` |
| `current/selection.adrLow14Pct` | Mean 14-session `(high-low)/low × 100` |

Base `atrPeriod`, `atrMethod` and `atrSimpleMethod` identify its configuration.
Missing warmup makes the affected part unavailable; it is not silently trimmed.
Existing presets continue using their original Wilder contraction.

Native canonical `adr_percent_20`, scanner ADR and browser `adr20Pct` use close.
Legacy display ADR fields, `range_percent`, `range_percent_low` and the explicit
`adr_percent_low_20` use low. Native artifacts publish denominator metadata.
`atr_simple_14` is an absolute price value, not a percentage.

## Closing versus intraday 52-week context

The window is 252 observed trading sessions, with complete-window warmup.
`closing52wHigh/Low` are extrema of closes; `intraday52wHigh/Low` are extrema of
highs/lows. Values are rupees. Existing `distanceClosing52wHigh` and
`aboveClosing52wLow` retain closing-price semantics. The separate
`distanceIntraday52wHigh` is `(highest high-close)/highest high × 100`, while
`aboveIntraday52wLow` is `(close/lowest low-1) × 100`.

Intraday new-high/new-low event gates retain their high/low tests. A candle wick
may trigger those events while its close remains below the corresponding high.
These contexts and events do not become equivalent just because both use 252.

## Failure, signal and execution

| Fact | Meaning |
| --- | --- |
| `breakoutFailed` | A post-breakout close returned inside the base |
| `exitSignaled` | The configured stop or armed MA trail generated an exit |
| `tradeClosed` | A subsequent session provided the modeled exit execution |
| `trade.realizedReturnPct` | Executed entry-open to exit-open gross return |
| `trade.netRealizedReturnPct` | The same executed return after configured costs |

The flags are null before breakout, and selectable as 0/1 afterward. A failed
breakout can remain an open modeled trade; an exit signal can remain pending
until the next session. Returns are null until execution. The policy records
ATR period/seed, stop percentage, trail period, failure trigger, close-based
exit triggers, next-session-open execution, fees and slippage per side.

Existing entry and exit policies are preserved: breakout close is a signal;
entry is the following session open; stop/trail signals execute at the following
session open. The default fee and slippage are each 10 basis points per side.
Observed subsequent opens can differ materially from the signal price. This
model does not establish that a fill was possible during a suspension or price
limit. Forward 5/20/60-session breakout outcomes remain separate market-path
measurements, not realized trade returns.

## Compatibility and release

Engine version is `nexus-bases-4`; the generated scanner identity changes so old
packs cannot be mistaken for the new contract. Existing names remain aliases
where stated. Rebuilding the pipeline, chart artifacts and scanner packs is
required to populate new facts. Updating source code alone does not replace an
active R2 revision or browser pointer.

For current setup-family defaults, raw TR% measures, public/private projections
and replay policies, see [setup-family contracts](setup-family-contracts.md).
