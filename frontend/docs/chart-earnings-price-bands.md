# Earnings & Price Bands

Open Charts → Indicators → Fundamentals → Earnings & Price Bands. Its settings choose compact growth, essential results, or full results; quarterly/annual periods; EPS/PAT; 3–13 periods; text size; and panel position. Collapse or remove it from the panel header. Settings travel with each chart and saved/exported layouts.

The indicator reuses the release's published financial-history and earnings-calendar assets plus the selected snapshot's band, F&O and surveillance fields. It makes no calls to the reference extension's external services. Statement amounts are INR crore, EPS is INR/share, and OPM is percent. Growth is `(current − previous) / abs(previous) × 100`; missing or zero comparisons display a dash. Comparisons match calendar periods, including gaps.

A statement observation can include restatements, so all its values are hidden before `observed_on` in replay. Future periods and filings are also excluded. Missing historical releases never borrow the latest statements. Snapshot-only bands and surveillance are hidden before their dated availability; upcoming results are shown only after the calendar's observation date. Earnings markers use the existing dated filing ledger.

Optional dashed guides estimate next-session levels from the snapshot close and fixed band percentage. They are hidden during replay and for F&O/no-band securities. They do not include exchange tick rounding or other adjustments and are labelled estimates. Historical band revision labels and analyst estimates require additional dated data and are not synthesized.

Functional references: [QE Ultra](https://anotepad.com/notes/hpc3qj6j) and the supplied Price Band Extension 2.0. The implementation is native to Nexus and follows the app's light/dark theme.
