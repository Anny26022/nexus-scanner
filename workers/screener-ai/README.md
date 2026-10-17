# Compiler efficiency

The compiler keeps all available filter definitions in context. `compactCatalog.ts`
stores repeated parameter sets once and refers to them by index. Other filters
keep their parameters inline to avoid unnecessary reference lookups. Filter
meanings, parameter labels, enum labels/values, defaults, limits, steps, units,
integer rules and nullability are preserved.

The model returns only match logic and clauses: the quoted source phrase, status,
condition ID, variable parameters, optional negation and necessary assumptions.
Single-option settings are restored by the shared validator. Variable thresholds
remain required. `compilerResult.ts` derives the title, summary and labels locally.

Successful, fully supported compilations can be cached for six hours with the
Workers Cache API. Keys hash the trimmed request, dataset revision and complete
compiler prompt, so filter or instruction changes invalidate previous entries.
Requests are not case-folded or otherwise rewritten for caching.

Cache hits are revalidated against the current catalogue before being returned.
Unsupported/partial results are not cached. Invalid, oversized or unavailable
cache entries are treated as misses. Writes run through `ctx.waitUntil` and do not
delay the response. The cache is local to each Cloudflare data centre; a first
request in another location may require inference again.

Run the focused checks from `frontend/`:

```sh
npm run test -- --run src/__tests__/aiCompilerEfficiency.test.ts src/__tests__/aiCompilerFallback.test.ts src/__tests__/aiScreenerCompiler.test.ts
```
