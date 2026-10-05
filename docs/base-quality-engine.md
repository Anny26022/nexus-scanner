# Base quality, strength and breakout implementation

The implementation extends the scanner engine from PRs #20 and #21. It uses a
Nexus detector with causal closing-price peaks and configured pullbacks. It does
not claim result parity with another platform's undisclosed base detector.

## Completion requirements

- [x] Isolated branch on scanner compatibility baseline.
- [x] Initial causal base candidate and episode model.
- [x] Base boundaries, age, depth, parent relationships and closing-price pivot.
- [x] Average ATR and volume contraction; equal base slices.
- [x] Quiet-day depth/recency and up/down volume metrics.
- [x] Frozen breakout measurements and armed MA trailing exits.
- [x] Finish detection policy: local peak confirmation, overlap selection, nested
  invalidation, confirmed failed pokes and history completeness.
- [x] Historical RS ledger, rank progression, base RS summaries and industry
  relative returns with explicitly defined peer membership.
- [x] Trend distance/ratio/slope, median turnover and base context metrics.
- [x] Configurable strict holding and retest policies; episode termination facts.
- [x] Daily pipeline generation, artifact validation and durable episode outputs.
- [x] Public scalar metrics and private R2 episodes bound to one release revision.
- [x] Python, browser and advanced Worker evaluation with formula parity.
- [x] Editable Strong Bases, Fresh Breakouts, Holding Breakouts, VCP, Blue Sky,
  Multi-year and IPO Base presets.
- [x] Existing filter UI, compact stage selection and explanation columns.
- [x] Per-symbol chart base/pivot/breakout overlays.
- [x] Historical replay, forward outcome measurement and costs.
- [ ] Golden fixtures, prefix-invariance tests, integration and browser checks.
- [ ] New reviewed PR with exact scope, dependency and validation evidence.

## Formula contracts

Base-specific metrics use the inclusive detected start/end boundaries. At
breakout they exclude the breakout candle and freeze. Current distance to pivot
continues updating. ATR uses the existing Wilder implementation; half-volume and
half-ATR measures are daily means, with the first half receiving the extra
session for odd lengths. Parts divide into contiguous halves, thirds, quarters
and fifths. Zero denominators and missing warmup/RS observations are unavailable.

The initial detector confirms a candidate after a 5% close pullback from a local
peak. A close above its fixed pivot after at least 15 base sessions triggers an
episode. The default base depth ceiling is 60% and maximum duration 1500 sessions;
quality preset thresholds are tighter. These detector choices are versioned and
need historical validation.

Breakout volume uses the preceding 20-session median, excluding breakout day.
Fresh status covers ages 0 through 4 (the latest five sessions). The default exit
is a closing-price stop 8% below pivot or a close below SMA50 after that trail has
armed. Exit timing and execution costs must be explicit in replay; calculated
hypothetical outcomes are not real executions.

## Publication foundation

Publication computes episodes from histories aligned to the release session.
The technical pack contains one deterministic summary per lifecycle stage,
selected by the most recent breakout date (or start date for forming bases),
with the stable ID as a tie breaker. Detailed base slices and episode events
are stored in the matching private R2 auxiliary shard. All filters for one
stage must refer to that same selected ID; matching unrelated bases across
conditions would be incorrect. Python, browser and Worker evaluate the same selected episode IDs. Slice
arithmetic routes the complete expression to the Worker. Complete episodes
and dated rank ledgers remain in separate private archive shards, verified
with the manifest and excluded from latest-session scans.

The initial strength ledger uses weighted 63/126/189/252-session returns
(40/20/20/20 percent), ranked among the currently eligible aligned Nexus peers.
It is not a historical constituent universe and is not survivorship-free.
Missing observations are not forward-filled. Industry return context currently
uses equal-weight current-classification peers including the subject, with at
least three available peers; dated industry context uses the same current classification on each session.
Rank changes use the market session ledger.

Median turnover estimates traded value as close times volume; it does not
claim to reproduce exchange-reported turnover. Listing age uses an official
listing date and is unavailable when absent, rather than using cache length.

A breakout failure (first close back inside the base) is separate from a trade
exit. Forward 5/20/60-session returns and excursions are only populated after
the full horizon exists and continue measuring market outcomes after an exit.
Replay includes explicit fees, slippage, next-session execution and per-symbol
cohort aggregation.

## Editable Nexus presets

Seven `lib-nexus-*` definitions extend the original 45 offline presets. Strong
Bases, Fresh Breakouts, Holding Breakouts, VCP Base, Blue Sky, Multi-year Base
and IPO Base use the same stage-selected records as individual conditions.
Numeric thresholds and the holding policy are editable in the existing preset
panel. Changed thresholds are evaluated directly instead of using unchanged
precomputed matches. The defaults are research starting points.

Fresh Breakouts and Holding Breakouts apply quality checks to `selection`
(pre-breakout context) and contraction/depth checks to the frozen `base`.
Extension and pivot holding use current observations. Forming presets use
current context. Blue Sky requires no higher close in the available cache and history beginning
within seven calendar days of the official listing. This coverage check does
not independently audit missing bars or historical adjustments.

Targeted preset tests cover edited thresholds, frozen quality, session
alignment and strict/retest policies. Rendered fixture checks verify editing, Apply persistence, stage selection,
chart opening and Escape/focus restoration. Full-universe performance acceptance
and historical validation remain outstanding.

## Chart integration

Daily chart generation embeds the same deterministic selected base summaries
as scanner publication. Clicking a symbol opens its immutable-revision chart
on demand. The viewer shows daily candles and volume, the detected floor/pivot
range through the last base session, a pivot line, a breakout marker and concise
quality measurements. Stage selection is independent of filter editing. Missing
base records render plain candles; missing chart publication shows an error.
The chart payload remains backward compatible through an optional `bases` field.

Chart-generation fixtures verify equality with scanner base summaries, including
pre-breakout boundaries. SVG geometry tests verify the overlay coordinates and
missing-history behavior. Browser interactions have been verified with a labelled integration fixture.
Full-data performance acceptance remains outstanding.

## Local historical replay

From the pipeline directory, run:

```sh
python3 replay_base_breakouts.py --symbols RELIANCE --fee-bps 10 --slippage-bps 10
```

RS ranks still use the complete current eligible universe before optional symbol
selection. The default output is `.scanner_cache/base-replay.json.gz`. Qualified
Fresh Breakouts enter at the next session open. A closing stop or armed-MA exit
signal executes at the following session open. Fixed 5/20/60-session outcomes
exit at each horizon's final close and remain independent of trade exits.
Fees and slippage are applied on both sides. Incomplete observations stay null.
The output includes returns, excursions, failed pivot holds, counts and execution
assumptions. Historical membership reconstruction and validation of the proposed
thresholds on complete real histories are still required before interpreting
these results as an unbiased performance estimate.

## Detection and hierarchy policy

The newest mature episode per stage is selected deterministically. Overlapping
episodes remain in the private archive. A child increments its parent's nested
count only after reaching minimum duration while the parent remains forming.
Parent invalidation is recorded on active children; children remain independent
formations. A failed poke is confirmed when a close returns inside within ten
sessions without exceeding the frozen intraday ceiling. Configurable touch
tolerance is part of episode identity.

Invalid candles and duplicate dates are rejected. Missing trading sessions are
not fabricated. Closing 52-week measures require 252 sessions. Follow-through
continues after trade exit. Forward horizons require complete observations.
Intraday peak-to-trough drawdown is conservative: OHLCV cannot establish the
order of a session's high and low.

## Validation status

72 frontend tests and 13 Worker tests passed, including base metric/arithmetic
parity; Wrangler dry build and frontend production build passed. The pipeline
suite passed 228 tests including the hierarchy and failed-poke fixtures. Final regression and performance acceptance remain required.

The local stock artifact is dated 30 September 2026 while most OHLCV files
end on 1 October and omit 30 September. A separate 1 October benchmark covers
2,589 aligned histories; this is not a published release or proof that the
September snapshot was validated across the complete universe.

Public context includes the fields used by all seven presets and common strength
filters. Expanded SMA/EMA distance, slope and ratio variants remain in private
selected records; the dependency registry sends those complete expressions to
the advanced Worker. Published numeric values retain full precision.

Replay accepts `--stop-pct` and `--trail-period` to regenerate episodes under
a different exit policy. Each configuration changes stable episode identity.
