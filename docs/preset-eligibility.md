# Editable preset eligibility

Preset rules and universe eligibility are separate. Each selected preset shows
three editable restrictions: market cap > ₹1,000 Cr, close > ₹10, and 50-session
average daily turnover > ₹5 Cr. Unchecking a restriction removes it; checking it
again restores its default. All enabled restrictions are ANDed with the preset's
own expression. Easy Money retains its internal nine-way OR; Persistent Momentum
retains its EMA OR and explicit 20-session turnover ≥ ₹5 Cr condition. Removing
the shared 50-session restriction does not remove a preset's internal condition.

`src/data/presetEligibility.json` is shared by the browser and Python bridge.
Missing settings retain defaults; explicit JSON null removes a restriction.
Thresholds must be finite, non-negative numbers. Each preset stores its own
settings, so changing one preset does not change another. The existing outer
ALL/ANY selection and negation wrap the complete configured preset.

Publication keeps `presetMatches` unchanged for legacy/default clients and adds
`presetRuleMatches` (true/false/null before eligibility), with snapshot-level
`presetRuleMatchesVersion: 1`. The same history calculations and memoized leaves
are reused. Both plain and packed snapshots carry the new fields. Additional
rule evaluation is required for stocks the old eligibility gate skipped; no
production runtime improvement is claimed.

The browser combines rule-only results with the available current-snapshot
market cap, close, and `metrics.turnover50`, using strict > comparisons. Missing
or stale required values remain unknown, including under negation. Disabled
restrictions do not require their missing values. Filtering, sorting, pagination,
and export reuse the existing browser evaluator and match cache; no request is
made for each eligibility edit.

Old immutable snapshots remain unchanged and default scans continue working.
An eligibility edit on an older snapshot reports that a newer dataset is needed
instead of silently filtering an already-gated result. Merge/deploy the frontend
and run the next normal pipeline publication to activate customization. No
production refresh is triggered by this PR. Persistent Momentum is offered only
in Pre-built Scans; its internal condition definitions remain for preset execution
and legacy saved scans, not as new standalone filter choices.
