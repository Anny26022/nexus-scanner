# Price Band & Results

Open Charts → Indicators → Fundamentals → **Price Band & Results** to turn it on or off. Once on, it has its own legend row (hide, settings, remove), like any other indicator, and it is saved per chart and in saved or exported layouts.

The design follows the Price Band Extension 2.0, and the behaviour follows the QE Ultra Pine script:

- **Band badge** (top right; drag to move). The band segment is coloured by band: 20% blue, 10% green, 5% and 2% red, and no band (NB) or F&O grey. It also shows the results countdown (TODAY / TOMORROW / N DAYS) from the earnings calendar. A red segment shows the ASM/GSM stage, for example `LTASM - I`. The stage's internal code in brackets is dropped.
- **Results card** (below the badge; drag to move). The compact layout is the extension's `FQ EPS YoY QoQ Sales YoY QoQ` table, with the `MCAP | FF | LISTED` line and `Sector | Industry`. Rises are blue and falls are magenta, as whole-number percentages. The essential and full layouts are Screener-style grids, oldest period first. A cell is highlighted green when it beats every earlier value and red when it is the worst so far; for expenses, interest, depreciation and tax, lower counts as better.
- **Upcoming results "E".** A purple "E" sits at the bottom of the price pane on the next results date within 90 days, taken from the published earnings calendar (Nexus Journal, with ScanX as the fallback). Its position is counted in trading days past the last bar; weekends are skipped, but holidays aren't modelled. The chart scrolls to show it when the latest bar is on screen. A dotted line at that date is optional and off by default, as in the Pine script. Both are hidden in replay.
- **Past band changes.** A small label above the candle on each date a stock's band changed, coloured by the new band (20% blue, 10% green, 5%/2% red, NB grey), for example `10%`. On weekly and monthly charts it sits on the bar containing that date, and replay shows only changes up to the replay date.
- **UC / LC lines.** These are the next session's upper and lower circuit levels, calculated as the latest close × band and drawn blue and red, as in the Pine script. They are hidden for F&O and no-band stocks and during replay. They don't include the exchange's own rounding.

Settings choose which parts are shown, the layout, the period (quarterly or annual), EPS or PAT, the number of periods (3–13), and the badge and table sizes. A focused badge or card moves with the arrow keys (hold Shift for bigger steps). Older saves keep their dragged table position and text size.

## Data and replay

Data comes from the release's published financial history and earnings calendar, plus the selected snapshot's band, F&O and surveillance fields; there are no external calls. A statement observation can include restatements, so its values stay hidden before `observed_on` in replay, and future periods and filings are excluded. Snapshot-only bands and surveillance are hidden before their dated availability. Analyst estimates need a source, so they are not synthesised.

## Price-band history

Every archived daily snapshot (from 1 Oct 2021) stores each stock's band for that date. `price_band_history.py` folds them, in date order, into a ledger: a stock's first observed band, then one entry each time it differs from the previous one. Days where a stock is missing or its band is blank change nothing. The ledger is `price-band-history.json` next to `sessions.json`, and each release publishes it as `price-band-history.json.gz` (`priceBandHistoryUrl` in the manifest).

- **One-time rebuild:** `python price_band_history.py rebuild` downloads every archived snapshot (about 650 KB each) and writes the ledger. Sessions that still fail after retries are listed and skipped.
- **Daily:** `publish_snapshot.py` folds in only the new session, so the ledger stays current. Without a rebuild, it starts from the first published day.

Bands that changed before 1 Oct 2021 are unknown; the first archived band is treated as the starting point, not a change.
