# Rotation (relative rotation graph)

## Data

`frontend/rotation_history.py` runs inside snapshot publication and writes four content-addressed objects
next to the chart objects. The release manifest names the index as `rotationHistoryObject`.

- **Index** (always loaded): calendars, benchmarks, every stock with its index memberships and liquidity
  fields, every group with its members, and the hashes of the three shards.
- **Shards**: `core` (Nifty 500 stocks), `rest` (all other stocks) and `groups` (one composite per group).
  The page loads only the shards a view needs.

Each series is one close per period on three calendars: the last 300 sessions, 290 ISO weeks and 144 months.
Values are delta-coded natural logs at 0.01% resolution.

- **Stocks** are the published scanner rows' closes.
- **Groups** cover every classification level the screener uses: sector, industry, sub-industry, theme,
  thematic block and macro pillar. Each is an equal-weight chain index of its current members' daily returns.
  Members need ₹300 Cr market cap and ₹1 Cr 30-day turnover, and a group needs three members.
- **Benchmarks** are Nifty 50 and Nifty 500, from the refresh's index files, plus an equal-weight market built
  like the groups. Comparing equal-weight groups with a cap-weighted index would make every group look strong
  whenever small and mid caps outperform.

History uses today's group membership, so it is not a point-in-time backtest.

## Maths (`frontend/src/utils/rrg.ts`)

JdK's formula is unpublished; this is an open approximation.

- RS = price ÷ benchmark.
- RS-Ratio = 100 × EMA₅(RS) ÷ EMA₂₆(RS): above 100 while relative strength trends up.
- RS-Momentum = 100 × RS-Ratio ÷ EMA₉(RS-Ratio): leads RS-Ratio and turns first.
- Quadrants split at 100 on both axes.

Periods follow the chosen calendar, and the first 35 periods are warm-up.

## Page

- **Chart:** the chart opens with trails for the eight items that moved furthest over the trail. Everything
  else shows as a faint dot. Ticking an item in the rail adds its trail.
- **Replay:** steps one period at a time with gliding motion. Quadrant counts and the rail update live.
- **Benchmark strip:** shows the benchmark and a breadth ribbon, the share of items in each quadrant over
  time. Drag it to move through time.
- **Tracker:** ranks every item by quadrant and by how far it moved, with a trail sparkline and drill-down.
