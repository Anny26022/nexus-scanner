# Versioned setup families and historical measurement contracts

## What changed

Engine `nexus-bases-5` supplies four `nexus-setups-3` family presets alongside
the seven existing research presets and the original 45 scans (56 total).
Legacy standalone stage selection retains its 60% maximum-depth CLOSE policy.
Families use separately identified 95% candidate policies (CLOSE, and HIGH for
intraday Blue Sky), then apply their own editable depth gates. This reverses
the earlier v4 publication-wide 95% change, which could change legacy results.
Detector version and complete configuration participate in each base ID; IDs
therefore change across this engine release even when a formation is unchanged.
Charts, scanner publication, private packs, local scans and replay share these
policies. Neither arbitrary filters nor legacy screens silently inherit a family.

There is no additional market-data provider. Turnover uses official NSE traded
value, never close × volume as a substitute. These floors are NSE-only; a
combined NSE/BSE floor would require BSE ingestion.

## Editable family defaults

| Family | New preset ID | Important defaults |
| --- | --- | --- |
| VCP Setup | `lib-nexus-vcp-setup` | Raw TR% contraction 0.3–0.9, volume dry-up 0.05–0.9, 15–1,500 sessions, depth 2–35%, above SMA50/200, RS ≥70, within 30% of closing 52-week high and ≥15% above closing low |
| Blue Sky Setup | `lib-nexus-blue-sky-setup` | Available intraday-history ceiling, RS ≥70, 0–20% below pivot; depth ≤95% |
| Multi-year Setup | `lib-nexus-multi-year-setup` | ≥52 session-weeks (260 observed base sessions), ≤1,500 sessions, above SMA200, RS ≥60, 0–20% below pivot; depth ≤95% |
| IPO First Base | `lib-nexus-ipo-setup` | Listing age 2–50 market-session weeks, ≥15 base sessions, depth 2–35%, above SMA50, 0–20% below pivot; first structurally qualified base required |

All four require market cap ≥₹300 Cr and a complete 20-session median official
NSE turnover ≥₹1 Cr/day. Existing threshold controls edit those floors.
`maxBaseDepth` replaces the family's upper-depth gate, rather than adding a
second contradictory upper bound. The lower depth gate remains editable.
These are research defaults; no optimality or return guarantee is claimed.

## One formation through four stages

`setupStage` selects FORMING, FRESH_BREAKOUT, HOLDING or PLAYED_OUT. Every leaf
binds to one candidate. All candidates of the requested family, pivot basis and
stage are evaluated before selection. A match is existential: one candidate must
pass every family clause. The most recent qualifying start/breakout, then base
ID, selects a deterministic witness. Liquidity on one base cannot satisfy trend
on another. Missing data retains three-valued AND/OR semantics. During FORMING,
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

Confirmation is optional (`requireBreakoutConfirmation=false` by default).
When enabled for post-breakout stages, require breakout volume ≥1.5× the prior
20-session median, close-in-range ≥0.7 and positive closing distance through the
pivot. FRESH additionally requires age ≤5 sessions and current extension 0–5%.
All thresholds are editable. FORMING with confirmation enabled is rejected.
Holding/played-out qualification does not incorrectly impose a fresh-age limit.
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

`firstEligibleBase` identifies the earliest CLOSE family formation to reach
minimum duration and 2–35% depth. `structuralQualifiedDate` records the first
qualifying close causally; a later deterioration does not renumber formations.
An earlier overdeep pause is excluded. MA/liquidity edits remain separate gates:
a first base can qualify later after SMA50 warmup without becoming a different
base. Missing inception/observed-session coverage makes first-base identity
unavailable. This remains a disclosed structural definition, not a claim to
reproduce a proprietary detector. `requireFirstBase` disables the restriction.

Optional family policies (disabled by default):

| Parameter | Meaning |
| --- | --- |
| `strictContractionLegs` | At least two confirmed legs; each successive depth strictly smaller (ratio <1 by default) |
| `minPriorAdvancePct` | Close at base start versus 63 sessions earlier; insufficient lookback unavailable |
| `requireAccumulation` | Positive `(up volume − down volume)/(up volume + down volume)` within that base |
| `requireRising200` | Positive 21-session SMA200 slope |
| `reclaim200Within` | Close crossed above SMA200 within the last N sessions (age <N) |
| `slopeTurn200Within` | SMA200 slope crossed from nonpositive to positive within N sessions |
| `above50Persistence` | Consecutive closes strictly above SMA50; default one |

After breakout these gates read frozen prebreakout context. Strict leg mode
rejects a maximum ratio above1, and automatically requires two legs if a zero
minimum is supplied. Event windows and persistence are validated integer bounds.

## Available history versus audited lifetime history

Blue Sky offers three policies:

1. CLOSING_AVAILABLE: the closing-price proxy in available history, with the
   existing listing-start proximity check. This does not certify lifetime ATH.
2. INTRADAY_AVAILABLE (default): uses a separate HIGH candidate lifecycle with
   the actual established intraday ceiling as pivot. Breakout requires a close
   above it. The pivot must reach the available historical intraday high, and
   observed-session coverage must be complete. It is not a closing-pivot proxy.
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

Public packs keep the deterministic legacy selected scalar facts. Every new
family routes its complete containing expression to the advanced engine,
because evaluating only the selected legacy base can hide a qualifying older
formation. Private auxiliary shards contain all mature family candidates,
projected to qualification scalars (no slice arrays or hypothetical trade
histories). Complete archives remain separate private objects.

The Worker evaluates one candidate per family conjunction, releases shards, and
retains only witness IDs for pagination. `setupMatches` maps condition instance
IDs to the selected public base summary; chart `setupCandidates` uses those same
IDs and pivots. Repeated families may have different witnesses. Cached local
requests clear prior evidence before evaluation. No candidate is silently dropped.
Auxiliary publication rejects decoded shards above12 MiB before pointer
promotion, and Worker decompression is bounded to the same limit. Oversize
publications need a sharding/projection change rather than truncating history.

Python/TypeScript materialization and truth/witness selection are parity tested.
CLI family requests compile to the same correlated BASE_SETUP node. The engine
identity changes, so old/new snapshots cannot silently mix formulas.

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

### v5 verification

266 pipeline Python tests, 54 frontend Python tests, 84 shared/frontend
TypeScript tests and 16 Worker tests passed (420 total). Frontend production
build, Worker typecheck and Wrangler dry deployment succeeded.

The October1 recovered-history fixture contains RELIANCE7,810 candles,
TCS5,455 and VENUSPIPES1,074. Chart and private-pack projections are exactly
equal for all1,633 mature family candidates (951/534/148 respectively), after
using the same numeric CSV parser for base calculations. All130 private object
checksums passed. The largest decoded auxiliary shard in this fixture is
3,020,375 bytes, below its12 MiB guard. This three-symbol fixture is not a
full-universe performance or historical-RS correctness certification. It uses
only those three symbols as rank peers; deterministic correctness is verified,
not investment quality. Production R2/Worker releases are not promoted here.
