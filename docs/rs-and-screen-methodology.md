# RS and setup calculations

The canonical implementations are `build_rs_ratings.py` and
`build_market_screens.py` in the EDL pipeline directory. Daily publication,
historical backfills and Pattern Gallery reuse their functions. There is no
separate reference engine or legacy-formula fallback.

## Methodology `marketstrength_parity_v2`

RS ranks `0.40*R63 + 0.20*R126 + 0.20*R189 + 0.20*R252` across the eligible
universe for that date. Returns are fractional close-to-close returns. At least
127 observations are required. Missing 9M/12M returns use the available 6M
return. The published `front_weighted` key remains the existing scanner API
field, with the methodology version identifying the calculation.

`rs_change_21d` compares ranks on two common benchmark trading sessions 21
sessions apart. Each date uses its own eligible universe; it does not rerank the
older date against today's members. Without dated eligibility for the older
session the delta is unavailable.

## Dated eligibility and deployment

`rs_universe_history.json.gz` retains dated eligible symbol lists and the
methodology version. The daily RS job appends today's breadth-eligible universe.
The historical generator uses retained lists when present; otherwise it
reconstructs eligibility with the existing breadth eligibility function and
configuration, using dated price and capitalization. Historical coverage remains
limited to the surviving master universe and available filed fundamentals.
Unknown capitalization does not establish eligibility.

Daily/weekly output commits retain this archive. The backfill workflow also
commits it after a verified upload and includes it in the workflow artifacts.
Generate historical dates in chronological batches to supply prior membership
for RS deltas. On initial deployment, historical RS/Textbook coverage remains
unavailable until those dates have been backfilled; daily runs then retain it
automatically. No historical membership is fabricated from today's list.

Pattern Gallery reads this archive during normal daily generation. Occurrences
retain signal-date RS, traded value and liquidity, and only matured forward
returns. Historical earnings schedules remain explicitly unavailable because a
dated schedule archive is not maintained.

Backfills preserve stale stocks as visible rows but mark their history unaligned
and leave new setup measurements unavailable. The same setup function handles
daily and historical measurements, including the 250-session ceiling boundary.
ATR arrays are precomputed per stock and reused across backfill dates.

Changed calculations generate a new content-derived snapshot revision. Existing
frozen revision files must not be overwritten with recomputed fields. The dated
eligibility archive is operational input and is not duplicated into every frozen
frontend release.
