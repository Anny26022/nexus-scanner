# Precomputed base facts and arithmetic

The base detector version `nexus-bases-3` adds raw facts and slice measures to
the existing episode contract. It does not change the detector's threshold
policy. New identities prevent old incomplete records from appearing compatible.

## Data placement

Common summaries stay in the public technical pack. Absolute context facts
and base parts are stored in private selected-base auxiliary shards; full
historical episodes are retained in separate private archive shards. This avoids
duplicating every moving average in browser packs. An expression needing private
facts is sent intact to the advanced engine. Chart summaries use the same detector
and include the new base summary facts, without embedding private part arrays.

`current` means the release session. `selection` means the base's measurement
session, frozen before breakout; forming bases use their current base end.
All facts in one stage refer to the same deterministic selected episode ID.

## Fact paths

Under both `current` and `selection`:

| Facts | Paths |
| --- | --- |
| Price / market cap | `price`, `marketCapCr` |
| Official single-session turnover / shares | `turnoverCr`, `volume` |
| Median liquidity | `medianTurnover20` |
| Absolute SMA / EMA | `smaN`, `emaN`, N = 10, 20, 50, 100, 150, 200 |
| MA values 21 sessions ago | `smaNMonthAgo`, `emaNMonthAgo` |
| Mean traded value / share volume | `averageTurnoverN`, `averageVolumeN`, N = 10, 20, 50, 100, 200 |
| Strength | `rsRating`, `rsMonthAgo`, `rsChange5`, `rsChange22` |
| Official listing age | `listingAgeWeeks` |

Market cap requires a session-aligned current canonical value. Earlier selection
market cap is price-scaled using the current share-count basis; historical issues
and buybacks are not reconstructed. It must not be described as independently
observed historical capitalization. Missing alignment yields null.

Base summary additions:

- `base.ageWeeks`: sessions divided by five; not elapsed calendar weeks.
- `base.quietVolume` / `base.medianVolume`: minimum and median share volume.
- `base.quietTurnoverCr` / `base.medianTurnoverCr`: minimum and median official
  traded value. The minimum is computed independently of share volume.
- `base.quietDate` and `base.quietTurnoverDate`: separate dates; earliest wins
  when multiple days tie. Dates are published facts, not numeric comparisons.
- `base.quietTurnoverAgeSessions`: age relative to the frozen base end.
- Existing start/end RS, depth, pivot, hierarchy, failed pokes and squats remain.

The legacy daily table turnover field is not replaced by this scoped fact
contract. These named `turnoverCr` facts use official dated NSE history.

## Every base part

Parts are inclusive trading-session slices named `full`, `half_1..2`,
`third_1..3`, `quarter_1..4`, and `fifth_1..5`. Remainder sessions go to earlier
parts; empty parts have no measurements.

| Metric beneath `base.parts.<part>` | Measurement |
| --- | --- |
| `atrPct` | Daily mean Wilder ATR% |
| `volume` | Daily mean share volume |
| `turnoverCr` | Daily mean official NSE traded value in crore |
| `upVolume`, `downVolume` | Total shares on up/down sessions |
| `upTurnoverCr`, `downTurnoverCr` | Total traded value on up/down sessions, crore |
| `upDays`, `downDays` | Session counts |
| `changePct` | `(last close / first close - 1) * 100` |
| `highClose`, `lowClose` | Maximum / minimum closing price |

Up/down uses change against the preceding trading session, even when it lies
outside the part; unchanged sessions enter neither category. The first available
history session has no preceding close and enters neither category. One-session
parts have zero first-to-last return. Traded-value metrics require valid official
values for every session of that part; an incomplete whole base does not prevent
a complete smaller slice from being measured. No `close * volume` fallback exists.

MA historical offsets are 21 sessions; RS historical offsets are 22 market-ledger
sessions. Insufficient warmup and zero denominators remain unavailable. Current
RS uses the existing Nexus eligible peer population, not an external population.

## Query and API usage

Existing two-operand syntax remains valid:

```text
Base Formula(FORMING, base.parts.half_2.turnoverCr, DIVIDE, base.parts.half_1.turnoverCr) < 0.8
Base Metric(FORMING, current.sma150MonthAgo) > 100
```

Chained arithmetic is available through an optional `formula` string on
`BASE_FORMULA`, or the deterministic text query:

```text
Base Expression(FORMING, "(base.parts.half_2.turnoverCr / base.parts.half_1.turnoverCr) * 100") < 80
Base Expression(FORMING, "current.sma50 / current.sma200 - 1") > 0
```

Only allowlisted numeric metric paths, decimal constants, `+ - * /`, unary signs
and parentheses are accepted. Multiplication/division precede addition/subtraction;
operators of the same precedence associate left to right. No code evaluation,
function calls, property access outside the metric catalog or guessed clauses are
allowed. Limits are 2,048 characters, 64 tokens and parser depth eight. Invalid
formulas fail validation before shard evaluation. Missing operands, division by
zero and nonfinite arithmetic return unavailable; they are never coerced to zero.

Python and TypeScript share the metric catalog and have cross-language fixtures
for strict/equality boundaries, arithmetic, syntax rejection, missing data and
private selected-ID routing. Publication tests check that new facts survive
compressed private shard and archive serialization. Republish matching chart,
scanner and Worker versions to activate the new contract; old releases remain
immutable. No production release is implied by a local test or PR update.

## Measurement conventions

See [the versioned measurement contract](measurement-contracts.md) for overhead
proxies, the distinct ATR/ADR families, closing versus intraday 52-week context,
and breakout failure versus exit signal and executed trade return.
