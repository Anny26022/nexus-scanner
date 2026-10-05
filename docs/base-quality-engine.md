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
- [ ] Finish detection policy: local peak confirmation, overlap selection, nested
  invalidation, confirmed failed pokes and history completeness.
- [ ] Historical RS ledger, rank progression, base RS summaries and industry
  relative returns with explicitly defined peer membership.
- [ ] Trend distance/ratio/slope, median turnover and base context metrics.
- [ ] Configurable strict holding and retest policies; episode termination facts.
- [ ] Daily pipeline generation, artifact validation and durable episode outputs.
- [ ] Public scalar metrics and private R2 episodes bound to one release revision.
- [ ] Python, browser and advanced Worker evaluation with formula parity.
- [ ] Editable Strong Bases, Fresh Breakouts, Holding Breakouts, VCP, Blue Sky,
  Multi-year and IPO Base presets.
- [ ] Existing filter UI, compact stage selection and explanation columns.
- [ ] Per-symbol chart base/pivot/breakout overlays.
- [ ] Historical replay, forward outcome measurement and costs.
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
