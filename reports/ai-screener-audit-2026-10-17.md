# AI screener validation — 17 October 2026

## Decision

**Do not approve the current compiler configuration for production.** The catalogue covers the available definitions, but live model responses still change the meaning of requests. Parameter validation and the fallback do not reliably catch these changes.

This is a validation report. Another chat is editing the implementation; its changes were preserved. Results apply to the recorded snapshots, not to future edits.

## Scope and reproducibility

- Dataset revision: `33f1362d1044a9d684b528bfe5429a1e3a1953bcbf879a2d771162d68a039659`.
- Latest tested system-prompt SHA-256: `730ab31ae1a7aedd12f10f94a8282230fa595c463f93ed31d12ab1a692e8250f`.
- [Exact tested prompt](ai-screener-audit-2026-10-17-tested-prompt.txt). Qwen additionally receives `/no_think`; both models receive temperature 0, JSON mode, and a 2,200-output-token cap.
- [Latest provider responses, expected mappings, orchestration replay, and source fingerprints](ai-screener-audit-2026-10-17-latest-results.json).
- [Earlier prompt snapshot: 12 requests to each model](ai-screener-audit-2026-10-17-results.json). Its prompt hash differs; do not combine its scores with the latest snapshot.
- Latest evaluation: 12 live Qwen requests plus five live Llama requests for cases the Qwen response caused the orchestrator to reject. Captured provider responses were replayed through a frozen copy of the actual compiler/validator. These are targeted regression cases, not an estimate of general language accuracy. No model-generated reasoning is included in the artifacts.

## Catalogue coverage

The release-specific AI catalogue contains **104 definitions: 59 custom definitions and 45 named presets**. It is generated from the same catalogue and evaluator capability checks used by the editor. Preset eligibility parameters are included.

Published choices include 105 sectors, 434 industries, three series, five price bands, 99 indices, and 35 TradingView metrics. Unpublished choices and unsupported parameter combinations are rejected. This does not mean every definition has data for every stock; missing or stale values remain unknown.

Coverage tests exercise every definition's defaults, finite enum combinations using a small taxonomy fixture, individual/all multiselect values, and preset eligibility switches. They do **not** exhaust numeric values, arbitrary multiselect subsets, every published taxonomy combination, or English/Hinglish paraphrases. No finite test suite can establish all natural-language variations.

The audit also found evaluator capability mismatches: quarterly earnings settings were backed by TTM values; monthly RS settings used price returns; average-volume windows were ignored; MA convergence ignored selected averages. The working tree now restricts unsupported earnings/RS definitions and honours the published volume windows and convergence settings. Those capability changes are distinct from proving that the model selects the correct filter.

## Current model and fallback

- Primary: `@cf/qwen/qwen3-30b-a3b-fp8`.
- Fallback: `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.
- This is an explicit, fixed sequence in `workers/screener-ai/compiler.ts`, not automatic Cloudflare model routing.
- Maximum two model attempts; primary timeout 30 seconds, fallback 45 seconds, overall Worker budget 78 seconds.
- Provider errors, malformed/truncated output, invalid IDs/parameters, missing variable parameters and uncovered source text trigger the fallback.
- A narrow guard rejects `PRICE_VS_EMA` when its quoted source explicitly says “latest/current close/price”. It misses other equivalent wording, including the tested Hinglish request.
- Explicit `UNSUPPORTED` output is returned without a model retry. The UI blocks Run when unsupported clauses remain and permits the user to edit supported filters.
- If both attempts fail, the endpoint returns an error. There is no silent regex replacement or third model.
- Fully supported compilations have a six-hour result-cache TTL, keyed by dataset revision, system prompt and trimmed request. Entries are revalidated against the current catalogue. Cache failure permits fresh inference.

**Limitation:** the checks prove parameter validity, not that the filter expresses the user's meaning. Repeating the entire request as `sourceText` can satisfy textual coverage while omitting or changing constraints. An `EXACT` status is supplied by the model and is not a semantic proof.

## Latest 12-case results

| Request | Outcome after fallback handling |
| --- | --- |
| Current close above EMA200 AND volume ≥2×20-day average | Correct after Llama fallback |
| Hinglish: close above EMA50 AND market cap ≥1000 crore | Wrong: historical EMA persistence selected; accepted |
| P/E ≤25 AND ROE ≥15% | Wrong: unrequested P/E ≥0 added; accepted |
| Current close above EMA200 OR SMA50 | Correct |
| BANKS sector AND NIFTY 500 | Correct |
| Market cap >1000 crore | Wrong: became ≥1000; accepted |
| 20-day average turnover ≥100 lakh | Both attempts rejected; conversion unavailable to user |
| Average-volume 10/60 ratio ≥1.5 | Wrong: became current relative-volume range; accepted |
| Easy Money with custom preset eligibility | Both attempts rejected; required preset parameters omitted |
| Supertrend green AND current close above EMA200 | Whole request unsupported; supported EMA clause lost; Run blocked |
| Quarter-on-quarter EPS growth ≥20% | Wrong: fallback substituted year-on-year growth; accepted |
| EMA200 AND (market cap ≥1000 OR P/E ≤20) | Both attempts rejected; clear unsupported response expected |

**Three fully correct, five accepted semantic errors, three closed failures, one unsupported response with a lost supported clause.** Only one of five fallbacks produced a correct complete translation in this sample. Llama alone also failed several cases under the earlier prompt; selecting it as primary is not an established fix.

### Confirmed changes to screening results

Synthetic stocks were passed through the real snapshot evaluator, proving these are execution differences rather than cosmetic differences in condition IDs:

| Boundary input | Requested condition matches | Model condition matches |
| --- | --- | --- |
| Market cap exactly 1000 crore, request >1000 | No | Yes |
| P/E −5, request P/E ≤25 | Yes | No, because minPe=0 was added |
| Close 90, EMA50 100, published historical run still positive | No for current close above EMA50 | Yes for EMA persistence |

## Priorities for the implementation owner

1. **P1 — Prevent valid-looking semantic substitutions.** Validate strict/inclusive comparisons, unrequested bounds, reporting periods, volume definitions/windows, and current-price versus persistence meanings. Known contradictions must cause rejection or clarification, including after fallback. The tested quarterly request currently becomes an executable yearly-growth screen.
2. **P1 — Preserve every requested constraint.** Text-span coverage alone is insufficient. Require clause-level extraction and an explicit unsupported clause for any unrepresentable part; do not accept a whole-query quote as evidence that all conditions were translated.
3. **P1 — Make preset eligibility and unsupported logic explicit.** Populate the preset's editable parameters rather than adding independent filters that leave preset defaults active. Preserve supported clauses beside unsupported ones. Reject mixed nested logic without flattening it.
4. **P2 — Reduce context after correctness is established.** Retrieve relevant full schemas from a compact index of every capability, with expansion when uncertain. Keep all filters discoverable, but avoid resending hundreds of taxonomy values and irrelevant parameter schemas for every simple request. Benchmark retrieval misses as well as token savings.
5. **P2 — Complete cache and usage accounting.** Include model/semantic-validator version changes in cache invalidation. Cache keys currently contain the prompt/revision but not model selection or semantic guard code; cache reads do not rerun `checkCoverage`. Failed-attempt logs record zero tokens, and malformed/truncated outputs can lose usage before it is accumulated. Cache-hit token totals describe the original inference, not new spending.
6. Add regression fixtures for the observed failures and a larger independently expected English/Hinglish corpus spanning every family, comparison, unit, period, negation, logic form and unsupported capability. Re-run after the other chat's changes; passing catalogue tests is not a release gate for translation accuracy.

## Token use and free allowance

Measured on the latest prompt, which is 51,197 characters and includes all 104 definitions:

| Model | Requests measured | Mean input tokens | Mean output tokens | Mean Neurons | Mean provider latency |
| --- | ---: | ---: | ---: | ---: | ---: |
| Qwen3 30B A3B | 12 | 15,973 | 134 | 77.94 | 1.77 s |
| Llama3.3 70B | 5 | 15,402 | 148 | 441.14 | 9.02 s |

Qwen is materially cheaper, but the full-catalogue input still dominates token use. All measured provider responses reported zero cached input tokens. Application result-cache hits can avoid inference, but should not be confused with provider prompt caching.

The 12-query pipeline sample consumed 3,140.98 Neurons across its 17 model calls, averaging 261.75 Neurons per uncached request. At the same mix this would allow about 38 requests from a completely unused 10,000-Neuron daily allocation; primary-only requests at the measured mean would allow about 128. These are arithmetic estimates, not capacity guarantees, and the allocation is shared with other account use. Rejected translations still consume inference.

Cloudflare documents 10,000 free Neurons per day and $0.011 per additional 1,000 Neurons on Workers Paid, resetting at 00:00 UTC. Actual account billing-plan eligibility was not established in this audit. [Official pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), [Qwen model](https://developers.cloudflare.com/workers-ai/models/qwen3-30b-a3b-fp8/), [Llama model](https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/).

**Model recommendation:** keep Qwen as a low-cost candidate for further evaluation, not an approved production default. The tested Qwen/Llama pair does not meet the requested translation reliability. No alternative model was established as a reliable replacement by this audit.

## Automated and local validation

- Targeted AI/catalogue/fallback/cache/modal/availability/snapshot tests: **1,009 passed across seven files**.
- Full frontend suite: **1,520 passed, five failed across 58 files**. All five failures stop at `savedUnavailableConditions.test.tsx:41`: expected “Saved filters are unavailable”; rendered text is “Unavailable in snapshot:…”. Later behavioral assertions in those cases were therefore not reached. The concurrently edited warning UI/tests were not changed by this reporting pass.
- Frontend and Worker TypeScript checks: passed.
- Frontend production build: passed, with an existing large-chart-chunk warning.
- App at `http://localhost:8080/`: HTTP 200.
- Local integration smoke check: **failed to respond**. Two requests through port 8080 timed out after 90 seconds with no response bytes; even a GET to the Worker API on port 8787 timed out after five seconds. Result-cache behaviour was therefore not demonstrated over local HTTP. Cloudflare provider inference and frozen orchestration replay succeeded separately; they do not establish that the local app-to-Worker path works.
- `git diff --check` reports two trailing-whitespace lines in the concurrently edited `UnavailableConditions.tsx` (lines 34–35). No formatting edits were made to that file during this reporting pass.

No deployment or publishing was performed by this validation pass.
