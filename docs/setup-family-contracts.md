# Versioned setup families and historical measurement contracts

## What changed

Engine `nexus-bases-4` adds four `nexus-setups-2` family presets alongside the
seven existing `nexus-bases-1` research presets and the original 45 scans.
The library now contains 56 presets. The existing seven expressions and IDs
remain unchanged. New publications use a broader candidate detector: maximum
base depth 95%, previously 60%. Consequently, selected base identities, nested
structure and old preset result lists can change on a newly published release.
This is a versioned calculation change, not a promise of identical old results.
Direct `BaseConfig()` still defaults to 60%; use `--max-depth-pct 60` to reproduce
that detector policy in replay. Scanner, chart and private-pack publication all
use the same 95% candidate policy, then apply each setup's separate depth gate.

There is no additional market-data provider. Turnover uses official NSE traded
value, never close × volume as a substitute. These floors are NSE-only; a
combined NSE/BSE floor would require BSE ingestion.

## Editable family defaults

| Family | New preset ID | Important defaults |
| --- | --- | --- |
| VCP Setup | `lib-nexus-vcp-setup` | Raw TR% contraction 0.3–0.9, volume dry-up 0.05–0.9, 15–1,500 sessions, depth 2–35%, above SMA50/200, RS ≥70, within 30% of closing 52-week high and ≥15% above closing low |
| Blue Sky Setup | `lib-nexus-blue-sky-setup` | Available closing-history ceiling, RS ≥70, 0–20% below pivot; depth ≤95% |
| Multi-year Setup | `lib-nexus-multi-year-setup` | ≥52 session-weeks (260 observed base sessions), ≤1,500 sessions, above SMA200, RS ≥60, 0–20% below pivot; depth ≤95% |
| IPO First Base | `lib-nexus-ipo-setup` | Listing age 2–50 market-session weeks, ≥15 base sessions, depth 2–35%, above SMA50, 0–20% below pivot; first eligible detected base required |

All four require market cap ≥₹300 Cr and a complete 20-session median official
NSE turnover ≥₹1 Cr/day. Existing threshold controls edit those floors.
`maxBaseDepth` replaces the family's upper-depth gate, rather than adding a
second contradictory upper bound. The lower depth gate remains editable.
These are research defaults; no optimality or return guarantee is claimed.

## One formation through four stages

`setupStage` selects FORMING, FRESH_BREAKOUT, HOLDING or PLAYED_OUT. Every leaf
uses the same deterministic selected base ID for that stage. During FORMING,
context uses current facts. After breakout, qualification uses `selection.*`
observations at the final prebreakout session, including market cap, turnover,
RS, trend, listing age and pivot proximity. A later price or rank change cannot
replace frozen setup facts with current-session facts within that revision.
Historical market cap is price-scaled from the publication share-count basis;
share issuance/buybacks are not reconstructed. RS uses the current eligible
universe. Rebuilding a later release can therefore change these historical
proxies; they are not certified point-in-time fundamentals or constituents.
Base slices also exclude the breakout
candle and freeze at breakout.

The family presets classify the setup; they do not implicitly add a volume
confirmation rule. Apply `breakout.volumeRatio`, `breakout.closeInRange`,
`breakout.throughPct` and `breakoutAgeSessions` explicitly when desired.
The existing Fresh Breakouts screen already supplies those confirmation gates.
Holding policy may allow any selected episode, require continuous holding, or
allow retests while the current close remains above pivot. Played-out family
qualification is separate from its eventual hypothetical trade return.

## ATR and raw true range

For each daily candle:

```
TR = max(high - low, abs(high - previous close), abs(low - previous close))
TR% = TR / close * 100
```

The first available candle uses high − low. `base.parts.<part>.trueRangePct`
is the arithmetic mean of daily TR% within that part, with no ATR smoothing.
`base.trueRangeContraction` is second-half mean TR% / first-half mean TR%.
`current.trMeanPct10/20/50/100/200` and matching `selection.*` fields use complete
rolling windows. Missing windows and zero denominators stay unavailable.

The new VCP family defaults to RAW_TR. `contractionMethod` can select
WILDER_ATR or SIMPLE_ATR instead. Wilder ATR contraction and simple-smoothed ATR
contraction remain separately named and available; neither is interchangeable
with raw daily TR% means. The seven older presets retain their Wilder formulas.
Legacy ADR `/ low` and scanner ADR `/ close` remain separate contracts, as do
closing-price high/low context and intraday high/low events.

## Ages, confirmed legs and IPO provenance

- `base.ageWeeks`: observed inclusive base-session count ÷5.
- `base.ageCalendarWeeks`: elapsed days between first and final base candles ÷7.
- `current.listingAgeWeeks`: elapsed calendar days since official listing ÷7.
- `listingAgeSessions` and `listingAgeSessionWeeks`: observed release market
  sessions from listing through the context date, divided by5 for weeks.

The market-session ledger is the union of aligned histories in this release,
not a certified NSE trading calendar. A partial research universe can omit
market dates. Coverage diagnostics always state that basis.

Confirmed contraction legs use a close-based reversal walk with configurable
5% noise by default. High-to-low depths use candle high/low at the confirmed
close extremes. A terminal unconfirmed pivot is excluded. The published
`contractionMaxRatio` is the largest successive leg-depth ratio; requiring it
≤1 means every completed contraction is no deeper than the preceding one.
`minContractionLegs=0` disables the gate; enabled values are integers 2–10.
One leg cannot establish a contraction ratio. Replay exposes the noise setting;
publication records its detector policy. Complete depth arrays stay private.

`firstEligibleBase` identifies the earliest detected formation reaching the
minimum duration under the detector's configuration, before latest-stage
selection. It does not mean the first base passing every configurable IPO
preset filter. It stays unavailable when listing coverage is absent or gaps
exist; a truncated cache never establishes a first-lifetime-base claim.
`requireFirstBase` can disable this extra IPO restriction.

## Available history versus audited lifetime history

Blue Sky offers three policies:

1. CLOSING_AVAILABLE: the closing-price proxy in available history, with the
   existing listing-start proximity check. This does not certify lifetime ATH.
2. INTRADAY_AVAILABLE: additionally requires complete observed-session coverage
   and the closing pivot at least as high as the available historical intraday
   high. Wicks above a closing pivot can make this stricter test fail.
3. AUDITED_INTRADAY: additionally requires independently verified adjusted
   lifetime-price provenance. Without it, this clause is unavailable.

Optional `base_history_audits.json` or `.json.gz` maps symbols to objects:

```json
{
  "EXAMPLE": {
    "pricesAdjusted": true,
    "sessionsVerified": true,
    "source": "independent reconciliation identifier",
    "historyStartDate": "2022-05-24",
    "throughDate": "2026-10-01"
  }
}
```

These values must come from a real reconciliation, not inferred cache length.
Dates must match official listing and the latest candle, and observed coverage
must also be complete. Missing provenance remains null, known coverage gaps
produce zero. The loader is shared by chart generation, publication, local
bridge and replay. Publication freezes the audit input with the backend revision.
It does not generate or certify provenance automatically.

## Replay: risk sizing and optional breakeven

The default replay remains close-signal / next-session-open execution. A pending
entry or exit remains pending until its next candle exists. Breakout failure,
trade-exit signal and executed exit remain separate events.

`--breakeven-gain-pct 0` disables the new policy. A positive value arms only once
a known close reaches both the requested gain above the actual entry open and
the cost-aware breakeven price. The cost-aware price is
`entry × (1 + cost) / (1 − cost)`, where cost is per-side fee plus slippage.
A subsequent close below that level signals BREAKEVEN; execution still occurs
at the following open. Gaps can therefore produce a realized loss.

`--risk-pct` defaults to1.5% and `--max-position-pct` to100%. Sizing uses actual
entry, pivot stop and costs on both sides. An optional `--capital` rounds shares
down to whole shares; insufficient capital is BELOW_ONE_SHARE. Invalid stops
return unavailable sizing. Planned risk is not a guaranteed maximum because
stops execute after a close signal, at a potentially gapped open.

```
python3 "DO NOT DELETE EDL PIPELINE/replay_base_breakouts.py" \
  --root /path/to/pipeline --symbols RELIANCE,TCS,VENUSPIPES \
  --preset lib-nexus-vcp-setup --min-contraction-legs 2 \
  --breakeven-gain-pct 10 --capital 100000 --risk-pct 1.5 \
  --output /tmp/base-replay.json.gz
```

The output includes detector settings, family parameters, sized capital returns
and independent 5/20/60-session outcomes. It is per-signal research, not a
portfolio simulation of overlapping positions. Historical selection still uses
today's eligible universe; it is not survivorship-free. Preset replay reads
frozen prebreakout measurements and never uses future returns to qualify entry.

## Publication and execution

Public technical packs retain selected scalar facts and current/frozen context
needed by default family presets. Strict intraday/lifetime policies, less-used
raw base statistics and industry/benchmark context use the private pack; the
entire expression routes to advanced if any leaf needs those fields. No
condition is omitted. Private packs retain full slice detail, confirmed-leg
arrays and complete episode archives. Both use the shared publication engine.
Python and TypeScript materialize the same expression, preserving exact
comparisons and whole nested-expression routing. Advanced evaluation reads
private detail by the same published base ID, rather than finding another base.
The engine identity changes, so old/new snapshots cannot silently mix formulas.

Regression tests cover materialization across all four stages, edited floors,
strict policy errors, raw TR% means, missing history, independently supplied
provenance, confirmation without terminal pivots, cost-aware sizing and pending
breakeven execution. Cross-language tests compare all exposed metrics and
Python/TypeScript family expressions. Local real-history publication checks
chart, scanner and private-pack facts before deployment.

The previous full-universe snapshot projected through the smaller public field
contract measured 3,475,121 compressed bytes across its three packs (previously
3,969,941). This is a projection of the previous dataset, not a measurement of
a new full-universe release. Each actual publication still enforces the 4 MB
combined-pack limit before promoting its pointer. Real-history integration in
this change generated and checksum-verified 130 private objects for a three-stock
fixture, with chart/scanner values equal; this does not certify full-universe
CPU, memory or packet-size targets.
