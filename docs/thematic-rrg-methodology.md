# Thematic rotation methodology

The map is a raw excess-return/RS-change view, not normalized JdK RRG or a
measurement of fund flows. NIFTY 500 is the benchmark.

- Theme X: median member return over 63 stock sessions minus the benchmark's
  63-session return. One- and six-month excess use 21 and 126 sessions.
- Theme Y: median of each available member's RS rating now minus its rating
  21 benchmark sessions earlier. Every anchor delegates to the shared
  `marketstrength_parity_v2` engine and uses its dated ranking universe.
- Zero belongs to Leading when both axes are nonnegative, Improving when only
  Y is nonnegative, Weakening when only X is nonnegative, and Lagging otherwise.
- Display eligibility remains market cap >₹999 crore, close >₹10, at least 65
  sessions, and the existing 30-session turnover field >₹5 crore. The removed
  median 20-session turnover gate is not applied. Groups need three constituents.
- The displayed 20-session turnover is median close × volume, in crore rupees.
  This display filter is separate from the universe used for percentile RS ranks.
- Canonical theme classification supplies primary, curated, industry, override,
  and dynamic recent-listing memberships. The builder reads fresh enriched JSON
  before the previous compressed master when both exist during the daily build.

New listings are a separate tactical model: 10-session (or listing-to-date)
excess return versus the same dated benchmark interval, and last-five-session
average volume relative to listing-to-date average volume, minus one, expressed
as a percentage and capped at -100 to +300. Each historical IPO point uses only
observations available on that date. Stale and future candles are excluded.

Weekly replay traces today's constituents and taxonomy at past dates. It is
not a point-in-time membership backtest. Missing dated ranks produce missing
points; they never become zero momentum or live coordinates. Replay omits live
breadth, stock details, and future trail observations. Historical RS requires
the dated universe archive; a backfill is needed for dates before collection.

The daily Monday–Friday build stages the RRG artifact. The scanner publisher
creates its immutable sidecar and advances only `current.json` after completing
the scanner release. Frozen scanner release manifests stay unchanged. The weekly
fundamentals refresh retains the existing sidecar pointer without recomputing it.
The frontend reads the advertised sidecar, validates its methodology/schema,
and bounds its cache by sidecar version; it does not try legacy RRG aliases.
