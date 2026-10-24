# Rotation (relative rotation graph)

## Data

`frontend/rotation_history.py` runs inside snapshot publication and writes four content-addressed objects.
The release manifest names the index as `rotationHistoryObject` and where to fetch it as `rotationUrlTemplate`.

- **Index** (always loaded): calendars, benchmarks, every stock with its index memberships and liquidity
  fields, every group with its members, and the hashes of the three shards.
- **Shards**: `core` (Nifty 500 stocks), `rest` (all other stocks) and `groups` (one composite per group).
  The page loads only the shards a view needs.

Each release's files hold the whole replay window, so earlier releases' files are never read again. They are
uploaded under `daily/rotation/`, where the bucket's existing `daily-charts-90-days` lifecycle rule expires them;
no publication code deletes anything.

Each series is one close per period on three calendars: the last 300 sessions, 290 ISO weeks and 144 months.
Values are delta-coded natural logs at 0.01% resolution.

- **Stocks** are the published scanner rows' closes.
- **Groups** cover every classification level the screener uses: sector, industry, sub-industry, theme,
  thematic block and macro pillar. Each is an equal-weight chain index using dated membership and liquidity
  eligibility. Members need ₹300 Cr market cap and ₹1 Cr 30-day turnover. Each day needs three members with
  returns; under-covered periods are gaps. The index resumes at its retained level without bridging the
  uncovered return, and indicator warm-up restarts.
- **Benchmarks** are Nifty 50, 100 and 500, Midcap 150, Smallcap 250, MidSmallCap 400 and Total Market, from
  the refresh's index files. Each stock universe defaults to its own index. There is also an equal-weight market
  built like the groups. Comparing equal-weight groups with a cap-weighted index would make every group look strong
  whenever small and mid caps outperform.

Group membership and eligibility are point in time going forward. Each run records every stock's six labels and eligibility in
`rotation_membership_ledger.json.gz`, storing only changes. The ledger is carried between runs in private
pipeline state (`tools/pipeline_state.py`), and a stock counts toward a group only on the days it belonged.
Removed or newly illiquid stocks remain historical constituents. Before observations began, the earliest
recorded labels and eligibility apply; older history is a reconstruction. Existing ledgers without eligibility
bootstrap it from the first run after this change. Drill-down member lists describe the current universe.
The theme label stores the union of primary and curated memberships, so a stock contributes once to each
theme. Scalar labels in older ledgers remain readable. Curated membership changes, including entry to or
exit from the young cohort, are dated from observation onward; earlier membership is a reconstruction.
Prices are never carried past a stock's last observation. Publication requires the Nifty calendar to reach
the requested session, so a stale benchmark cannot be presented as current Rotation data.

The builder loads one symbol's prices at a time and accumulates returns in compact numeric arrays, rather
than retaining all raw histories. A local benchmark for 2,590 stocks and 618 groups reduced peak resident
memory from 1.49 GB to 241 MB (84%), with runtime roughly unchanged at 31 seconds. This measures the local
builder, not the entire GitHub Actions job; the publisher also retains its existing scanner cache.

Rotation's output hash participates in the scanner revision. A failed rotation upload omits its references
and still publishes the scanner. Retries retain the already-published release's rotation binding; upload
recovery becomes visible in a subsequent revision. Rotation copy/check operations each have a two-minute
timeout, independent of the bulk uploader's longer limit.
The private ledger stays staged until release publication succeeds, so a failed publication cannot advance it.

Theme classification has only existed since October 2026, so no earlier dated memberships exist to backfill.

## Maths (`frontend/src/utils/rrg.ts`)

JdK's formula is unpublished; this is an open approximation.

- RS = price ÷ benchmark.
- RS-Ratio = 100 × EMA₅(RS) ÷ EMA₂₆(RS): above 100 while relative strength trends up.
- RS-Momentum = 100 × RS-Ratio ÷ EMA₉(RS-Ratio): leads RS-Ratio and turns first.
- Quadrants split at 100 on both axes.

Periods follow the chosen calendar. Both indicators require 34 consecutive observations; replay reserves
35 periods for warm-up. Insufficient-history items remain outside the plotted and ranked universe.

## Page

- **Chart:** every item is plotted with its trail. Trails draw stronger the further an item moved, and the ten
  biggest movers carry names, so the flow reads without picking anything.
- **Strength summary:** names the items whose RS-Ratio rose or fell most over the trail. This measures
  relative strength, not capital flows.
- **Replay:** steps one period at a time with gliding motion. Quadrant counts and the rail update live.
- **Benchmark strip:** shows the benchmark and a breadth ribbon, the share of items in each quadrant over
  time. Drag it to move through time.
- **Tracker:** defaults to descending RS-Ratio, with a trail sparkline and drill-down. The optional quadrant
  sort uses RS-Ratio within each quadrant; trail movement remains a separate sort.
  It renders 50 rows per page; every item remains reachable. Selecting an outlier expands the chart to fit
  its replay path while the unselected overview retains robust percentile bounds.
- **Default view:** thematic blocks (about 30 groups), which stay readable with every trail drawn.

## Local testing

`python3 tools/build_rotation_local.py` builds the same data from this checkout's cached OHLCV and the current
release's stock rows. Index history uses the publisher's reader, merging CSVs with the latest index snapshot.
The replay stops at the stock session with at least 90% coverage, and the CLI reports when that predates the
release; a newer index snapshot never fabricates newer stock candles. It needs only the standard library;
runtime depends on history size. The output goes to
`frontend/public/data/rotation/`, which is ignored by Git, and the dev server picks it up through `local.json`.
Re-run it after the caches change.
