# Rotation (relative rotation graph)

## Data

`frontend/rotation_history.py` runs inside snapshot publication and writes four content-addressed objects
next to the chart objects. The release manifest names the index as `rotationHistoryObject`.

- **Index** (always loaded): calendars, benchmarks, every stock with its index memberships and liquidity
  fields, every group with its members, and the hashes of the three shards.
- **Shards**: `core` (Nifty 500 stocks), `rest` (all other stocks) and `groups` (one composite per group).
  The page loads only the shards a view needs.

Each release's files hold the whole replay window, so earlier releases' rotation files are not needed. After
a release is uploaded, publication keeps only the new release's files and those of the release live in Git.
It deletes the rest; their names are tracked in the private `rotation-state/published.json`, so chart objects
in the same `objects/` prefix are never touched. If the live release's files cannot be read, nothing is deleted.

Each series is one close per period on three calendars: the last 300 sessions, 290 ISO weeks and 144 months.
Values are delta-coded natural logs at 0.01% resolution.

- **Stocks** are the published scanner rows' closes.
- **Groups** cover every classification level the screener uses: sector, industry, sub-industry, theme,
  thematic block and macro pillar. Each is an equal-weight chain index of its current members' daily returns.
  Members need ₹300 Cr market cap and ₹1 Cr 30-day turnover, and a group needs three members.
- **Benchmarks** are Nifty 50, 100 and 500, Midcap 150, Smallcap 250, MidSmallCap 400 and Total Market, from
  the refresh's index files. Each stock universe defaults to its own index. There is also an equal-weight market
  built like the groups. Comparing equal-weight groups with a cap-weighted index would make every group look strong
  whenever small and mid caps outperform.

Group membership is point in time going forward. Each run records every stock's six labels in
`rotation_membership_ledger.json.gz`, storing only changes. The ledger is carried between runs in private
pipeline state (`tools/pipeline_state.py`), and a stock counts toward a group only on the days it belonged.
Before the ledger began, a stock's earliest recorded labels apply, so older history still reflects the
first known classification.

Theme classification has only existed since October 2026, so no earlier dated memberships exist to backfill.

## Maths (`frontend/src/utils/rrg.ts`)

JdK's formula is unpublished; this is an open approximation.

- RS = price ÷ benchmark.
- RS-Ratio = 100 × EMA₅(RS) ÷ EMA₂₆(RS): above 100 while relative strength trends up.
- RS-Momentum = 100 × RS-Ratio ÷ EMA₉(RS-Ratio): leads RS-Ratio and turns first.
- Quadrants split at 100 on both axes.

Periods follow the chosen calendar, and the first 35 periods are warm-up.

## Page

- **Chart:** every item is plotted with its trail. Trails draw stronger the further an item moved, and the ten
  biggest movers carry names, so the flow reads without picking anything.
- **Flow line:** above the chart, "Money flowing in" and "Flowing out" name the items whose RS-Ratio rose or
  fell most over the trail.
- **Replay:** steps one period at a time with gliding motion. Quadrant counts and the rail update live.
- **Benchmark strip:** shows the benchmark and a breadth ribbon, the share of items in each quadrant over
  time. Drag it to move through time.
- **Tracker:** ranks every item by quadrant and by how far it moved, with a trail sparkline and drill-down.
- **Default view:** thematic blocks (about 30 groups), which stay readable with every trail drawn.
