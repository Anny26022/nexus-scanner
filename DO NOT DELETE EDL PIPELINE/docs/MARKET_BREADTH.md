# Market breadth artifacts

`process_mbi_market_breadth.py` produces date-aligned, auditable breadth data from normalized equity OHLCV history. The pipeline publishes:

- `market_breadth_v2.json.gz`: the all-active series plus Nifty 50, Nifty 500 and Nifty MidSmall 400 series.
- `sector_breadth_v2.json.gz`: matching history for each classified sector.
- `market_breadth_contributions_v2.json.gz`: per-date, per-metric symbol lists for audit and explanation.
- `breadth_universe_snapshot.json.gz`: fixed latest-snapshot eligibility audit for the securities used to build each breadth universe.
- `all_indices_history_v2.json.gz`: normalized history for every available index. The named Nifty panel subset is embedded in `market_breadth_v2.json.gz`.

Each percentage uses its own valid population. A 200-day SMA percentage therefore divides by securities with 200 valid sessions, while advance/decline and thrust percentages divide by securities with a valid prior close. Raw valid counts remain in every record.

The Market Breadth Gate can select published counts, ratios, breadth, thrust, range, volume, MBI, XP and Nifty return metrics. A gate is evaluated once for the selected session and applies to the full screen.
