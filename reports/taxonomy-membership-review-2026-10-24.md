# Taxonomy and multiple-membership review

Reviewed 24 October 2026 at commit `502104c7bd243d9d6d90a16b30c7144ecd65c573`. Concurrent workspace styling changes included an Earnings stylesheet import during final verification; its classification logic remained unchanged. The evidence file records that input change.

The foundation supports overlapping themes, but the application does not apply a consistent membership contract. Rotation handles overlaps and deduplication well. Grouped copy and Earnings discard secondary memberships. Alias handling, parent rollups, missing classifications, and historical-release fallback need clearer rules. The checked-in current release also contains mutually inconsistent classification artifacts.

This is a source and local-artifact review. No production deployment was inspected, no upstream business classifications were independently researched, and no application code or released data was changed. Counts below distinguish the stored snapshot from recomputing the current classifier against the same stock universe. Supporting counts, stock lists, versions, examples, and input hashes are in [the evidence file](../reports/taxonomy-membership-review-2026-10-24.json).

## Findings, in priority order

### 1. [P1] The checked-in release cannot pass its own taxonomy validation

For revision `97d357ce2b2079015853849c162eb21144b400e342ba8ddac9616d8d528e589a`, dated 23 October:

| Artifact | Taxonomy version prefix |
| --- | --- |
| `current.json` | `7ef33bbeee16` |
| Revision's `release.json` | `7ef33bbeee16` |
| `universe-classification.json` | `7ef33bbeee16` |
| `theme-classification.json.gz` | `598e78dbc5c2` |
| Recomputed with the current classifier | `c01390185dd3` |

The stored theme file and consolidated file disagree on 168 primary themes and 238 membership sets. This changes actual classifications, beyond metadata differences. The consolidated file contains no IPO / Young Bases memberships; the theme file contains 233, including 168 stocks assigned that cohort as their primary theme.

The adapter correctly rejects the theme file because its version differs from the manifest. A diagnostic probe using the actual checked-in bytes reproduced `Theme classification release mismatch`. This blocks thematic grouped copy and causes the Earnings behavior described in finding 3. These are confirmed local-release defects; deployment impact depends on which artifacts were deployed.

The current publisher already generates the theme and consolidated payloads together. Rebuild and publish a complete revision through that path, and validate the complete output before activating it. Treat an existing revision's contents as immutable. Add an integration check over the checked-in active manifest and its referenced assets, rather than relying solely on publisher fixtures.

Evidence: [adapter validation](https://github.com/Anny26022/nexus-scanner/blob/502104c7bd243d9d6d90a16b30c7144ecd65c573/frontend/src/api/realAdapter.ts#L230), [generation](https://github.com/Anny26022/nexus-scanner/blob/502104c7bd243d9d6d90a16b30c7144ecd65c573/frontend/publish_snapshot.py#L399), [manifest binding](https://github.com/Anny26022/nexus-scanner/blob/502104c7bd243d9d6d90a16b30c7144ecd65c573/frontend/publish_snapshot.py#L478).

### 2. [P1] The same “Theme” label means different membership sets across features

The current classifier, recomputed against all 2,612 snapshot stocks, produces **264 stocks with multiple memberships**, containing **266 secondary membership edges**:

| Secondary theme | Stocks |
| --- | ---: |
| IPO / Young Bases | 226 |
| Precision Engineering & Complex Manufacturing | 17 |
| India Data-Centre Buildout | 15 |
| Pharma CDMO & Complex Manufacturing | 4 |
| Emerging EMS | 4 |

Rotation uses primary plus memberships whose basis is `curated-rule`, with a set preventing duplicates. Grouped copy reads only `record.theme`. Earnings explicitly copies only the scalar theme/block/macro/subIndustry fields, then groups on one scalar label. The shared frontend `ThemeClassification` type does not declare `memberships` at all.

Concrete example: `CYIENTDLM` has primary theme `Industrial Systems & Controls` and secondary membership `Emerging EMS`. Rotation's membership resolver includes both. Copy by Theme and Earnings by Theme include only the first. The four strategic secondary themes in the table have no primary members, so they disappear entirely from those latter grouping paths. The IPO cohort shrinks to its seven primary-only stocks when using the recomputed current taxonomy.

This is a membership inconsistency even after accounting for legitimate universe differences. Rotation additionally applies liquidity and history eligibility; the counts above describe classification membership before those gates, not the number of visible Rotation constituents or reported earnings.

Use one shared, typed membership contract. Offer explicit `primary` and `all memberships` modes wherever both are useful. A feature named “Theme” should default to the same mode throughout the product. Export and Earnings must preserve the full membership data before grouping.

Evidence: [Rotation resolver](https://github.com/Anny26022/nexus-scanner/blob/502104c7bd243d9d6d90a16b30c7144ecd65c573/frontend/rotation_history.py#L125), [copy type and grouping](https://github.com/Anny26022/nexus-scanner/blob/502104c7bd243d9d6d90a16b30c7144ecd65c573/frontend/src/utils/copyResults.ts#L3), [Earnings join](https://github.com/Anny26022/nexus-scanner/blob/502104c7bd243d9d6d90a16b30c7144ecd65c573/frontend/src/components/EarningsTab.tsx#L242), [Earnings grouping](https://github.com/Anny26022/nexus-scanner/blob/502104c7bd243d9d6d90a16b30c7144ecd65c573/frontend/src/api/earnings.ts#L251).

### 3. [P2] Earnings turns classification download failures into classification results

`classifying` checks pending queries, but does not check `directory.isError` or `themes.isError`. Once a failed query stops being pending, the component builds facets from missing classification data. A theme-file failure can therefore place the entire visible dataset under `Unclassified`. Sector/industry grouping can instead fall back to the labels inside the earnings feed.

With finding 1, this is an immediate reachable case in the local release. It makes infrastructure or release failures look like company-mapping gaps and can silently change taxonomy authority.

Show classification load errors with retry, and retain a clear distinction between `loading`, `unavailable`, and a successfully loaded record with no mapping. Any fallback taxonomy should have an explicit policy and visible meaning.

Evidence: [queries and join](https://github.com/Anny26022/nexus-scanner/blob/502104c7bd243d9d6d90a16b30c7144ecd65c573/frontend/src/components/EarningsTab.tsx#L237), [pending-only guard](https://github.com/Anny26022/nexus-scanner/blob/502104c7bd243d9d6d90a16b30c7144ecd65c573/frontend/src/components/EarningsTab.tsx#L281), [facet rendering](https://github.com/Anny26022/nexus-scanner/blob/502104c7bd243d9d6d90a16b30c7144ecd65c573/frontend/src/components/EarningsTab.tsx#L354), [feed fallback](https://github.com/Anny26022/nexus-scanner/blob/502104c7bd243d9d6d90a16b30c7144ecd65c573/frontend/src/api/earnings.ts#L256).

### 4. [P2] Mirror aliases and aggregates can become primary business themes

The source defines 313 theme nodes, including 93 `mirrorOf` nodes. Normal explicit-symbol and industry-rule assignment skips mirrors, and the classifier describes them as aliases/aggregations rather than additional exposures. However, the scanner bridge and issuer overrides may assign them directly. Validation checks that a referenced theme exists, without checking its node kind.

Recomputing current code yields **46 stocks with a mirror node as their primary theme**. Examples:

- `ACSTECH` gets `IT Enabled Services`; the mirror points to BPM, Digital Services & BPO, and Analytics & Data Services.
- `ADDIND` gets `Readymade Garments/ Apparells`; the mirror points to `Apparel Brands & Retail`.
- Hotel bridge records can get `Hotels & Resorts`, while source-mapped peers get `Premium Hotels & Resorts`.

Rotation consequently creates separate peer groups for synonymous or overlapping labels. Some records also contain their own primary name in `aliases`.

Separate true aliases from aggregates. A one-to-one alias should resolve to a canonical node. A many-to-one umbrella such as the IT services aggregate should resolve to a union for lookup, or remain an explicitly typed aggregate; do not guess which underlying leaf a broad provider label proves. Reject inappropriate primary assignments or represent a deliberate broader classification distinctly.

Evidence: [bridge targets](https://github.com/Anny26022/nexus-scanner/blob/502104c7bd243d9d6d90a16b30c7144ecd65c573/frontend/theme_classification.py#L11), [existence-only validation](https://github.com/Anny26022/nexus-scanner/blob/502104c7bd243d9d6d90a16b30c7144ecd65c573/frontend/theme_classification.py#L120), [assignment and mirror handling](https://github.com/Anny26022/nexus-scanner/blob/502104c7bd243d9d6d90a16b30c7144ecd65c573/frontend/theme_classification.py#L137), [Rotation group IDs](https://github.com/Anny26022/nexus-scanner/blob/502104c7bd243d9d6d90a16b30c7144ecd65c573/frontend/rotation_history.py#L245).

### 5. [P2] Theme memberships and their parent blocks do not roll up consistently

The classifier stores one `block` and one `macro`, both derived exclusively from the primary theme. Rotation expands theme membership but leaves block and macro scalar. All five overlapping themes are placed under `EMERGING THEMES`; that block is absent from every macro pillar.

For example, a stock can participate in `Emerging EMS` in the Themes view while never participating in its declared `EMERGING THEMES` parent block. Under the current recomputation, 271 stocks have at least one membership in a theme declared under that block, but only seven have that scalar block. The current schema cannot tell consumers whether this is an intentional primary-business view or a missing rollup.

The right fix is to distinguish business taxonomy from cross-cutting exposures and lifecycle cohorts. Keep primary business block/macro for an exclusive business breakdown. If exposing an “all theme parents” view, compute distinct parent unions from every included thematic edge and count each stock once per parent. Keep IPO age outside the business macro tree. Decide explicitly whether strategic overlays have meaningful macro parents or no parent; `EMERGING THEMES` currently mixes several kinds of grouping.

Evidence: [primary parent projection](https://github.com/Anny26022/nexus-scanner/blob/502104c7bd243d9d6d90a16b30c7144ecd65c573/frontend/theme_classification.py#L185), [Rotation's scalar parent extraction](https://github.com/Anny26022/nexus-scanner/blob/502104c7bd243d9d6d90a16b30c7144ecd65c573/frontend/rotation_history.py#L127), [source graph](https://github.com/Anny26022/nexus-scanner/blob/502104c7bd243d9d6d90a16b30c7144ecd65c573/frontend/theme_tracker_source.json).

### 6. [P2] “Multiple membership” currently means five approved overlays, not arbitrary business participation

`assign()` accepts the first assignment regardless of the destination's flag. Once any membership exists, a subsequent theme is accepted only if that destination has `allowMultipleMembership`. Only the five themes listed in finding 2 have that flag.

The primary is whichever membership was inserted first. Priority is: source row theme, row curated themes, explicit symbol lists, source-industry rules, issuer override if still empty, provider-industry bridge if still empty, then the young cohort. Source ordering can therefore affect fallback primary assignment. A curated overlay can become primary before a later business fallback if the source row lacks a usable business theme.

There are **35 explicit-symbol theme candidates suppressed** because another membership already exists. Examples include `GNA` in `Drivetrain & Axles` when its primary is `Chassis & Metal Parts`, and `JASH` in `Process Engineering Equipment` when its primary is `Water & Effluent Mgmt`. These are review candidates, not proof that every suppressed assignment should be retained: some broad lists may intentionally be superseded by a more specific primary.

Make primary selection an explicit field/rule, independent of edge insertion. Define which nodes are exclusive business classifications and which accept overlapping exposures. Preserve intentionally superseded candidates in private audit diagnostics with a reason. If allowing a second business exposure, attach evidence to that edge and make downstream handling independent of the evidence label. Rotation currently hard-codes `curated-rule`; it would ignore a non-primary edge introduced with a different basis.

Evidence: [assignment gate and priority](https://github.com/Anny26022/nexus-scanner/blob/502104c7bd243d9d6d90a16b30c7144ecd65c573/frontend/theme_classification.py#L137), [implicit primary](https://github.com/Anny26022/nexus-scanner/blob/502104c7bd243d9d6d90a16b30c7144ecd65c573/frontend/theme_classification.py#L177), [basis filter](https://github.com/Anny26022/nexus-scanner/blob/502104c7bd243d9d6d90a16b30c7144ecd65c573/frontend/rotation_history.py#L131).

### 7. [P2] Historical taxonomy requests can silently return today's classification

`releaseFor()` catches an unavailable or invalid historical manifest and returns the latest release. `getThemeClassification(requestedRevision)` then validates the taxonomy against that substituted release, without checking that its revision is the requested one. A diagnostic probe reproduced a request for a missing historical revision successfully returning the latest taxonomy.

This can change a historical screen's classification when copying results or viewing Earnings. Some neighboring APIs already check `release.revision !== revision`, so the handling differs across the adapter.

Require exact revision matching for classification joins. Return a clear “classification unavailable for this release” state when the historical asset is absent. Historical Earnings seasons currently use the selected/current dataset's classification, which is a separate product choice: label it as current classification unless dated historical classification is actually supplied.

Evidence: [fallback](https://github.com/Anny26022/nexus-scanner/blob/502104c7bd243d9d6d90a16b30c7144ecd65c573/frontend/src/api/realAdapter.ts#L104), [taxonomy caller](https://github.com/Anny26022/nexus-scanner/blob/502104c7bd243d9d6d90a16b30c7144ecd65c573/frontend/src/api/realAdapter.ts#L230), [neighboring exact check](https://github.com/Anny26022/nexus-scanner/blob/502104c7bd243d9d6d90a16b30c7144ecd65c573/frontend/src/api/realAdapter.ts#L195).

## What the taxonomy actually consists of

The six user-visible grouping levels are not one verified hierarchy.

| Dimension | Source / representation | Current behavior |
| --- | --- | --- |
| Sector | Pinned StockScans symbol extract, then reviewed fallback/provider labels; scalar | Used by screener, tables, chart directory, Earnings and Rotation |
| Industry / basicIndustry | Same primary company taxonomy; scalar | Independent grouping by label, not a validated child of sector |
| Tracker industry | `industry` inside the thematic record, from the older Tracker row | Different field from stock-row `industry`; absent for newly bridged records |
| Sub-industry | Tracker `sub_industry`, exposed as `subIndustry`; scalar | Another imported label, not enforced as a child of the displayed industry |
| Theme | Primary scalar plus a membership map | Full primary/curated union in Rotation; primary-only copy/Earnings |
| Thematic block | Parent of the primary theme | Scalar; ignores secondary parent memberships |
| Macro pillar | Parent of the primary block | Scalar; Emerging Themes has no macro |
| Niche tags | Reviewed per-stock tags and evidence | Supplementary descriptive data; not wired into theme memberships or dedicated grouping/filter choices |
| Index membership | Stock-row array | Explicit multiple-membership matching and separate Rotation stock universes |
| IPO / Young Bases | Theme-shaped cohort based on available price-history sessions | Mixed into the business-theme membership map |

Primary company taxonomy priority is exact symbol extract first, reviewed fallback second, provider labels last; sector aliases normalize a small set of names. Original provider fields are retained separately. The thematic classifier uses a separate pinned source and its own fallbacks. Differences between the two authorities are therefore often intentional.

For example, `SBIN` has displayed industry `PSU Banks`, thematic source industry `Public Sector Bank Companies`, sub-industry `Banks - PSU`, and theme `Public Sector Bank`. These are related labels from different systems, not interchangeable values. `ANANTRAJ` and `TECHNOE` share displayed industry `Data Centre` while belonging to different sectors. Unifying them requires an explicit business decision, not merely renaming a field.

The filter catalogue describes these fields as “NSE sector classification” and “NSE industry classification,” while their implemented authority is the mixed source precedence above. Align that wording with the actual taxonomy rather than implying a verified official NSE hierarchy.

The snapshot has **106 sector labels and 482 industry labels**. **122 industry labels occur across multiple sectors**, involving 1,240 stocks. Industry is currently a global grouping dimension. If a strict sector → industry hierarchy is intended, add stable IDs and explicit parent relationships. The legacy breadth builder groups by industry alone but sets its parent sector from the first row; that field cannot reliably describe groups crossing sectors. The sector table was removed from Market in the latest source, so that legacy output issue is not a claim about a currently visible Market table.

Evidence: [primary taxonomy precedence](https://github.com/Anny26022/nexus-scanner/blob/502104c7bd243d9d6d90a16b30c7144ecd65c573/DO%20NOT%20DELETE%20EDL%20PIPELINE/src/edl_pipeline/transforms/fundamentals.py#L20), [consolidated field separation](https://github.com/Anny26022/nexus-scanner/blob/502104c7bd243d9d6d90a16b30c7144ecd65c573/frontend/theme_classification.py#L89), [legacy industry aggregation](https://github.com/Anny26022/nexus-scanner/blob/502104c7bd243d9d6d90a16b30c7144ecd65c573/DO%20NOT%20DELETE%20EDL%20PIPELINE/src/edl_pipeline/transforms/market_breadth.py#L70).

## Coverage, age, and identity caveats

- The classifier reports 2,611/2,612 mapped, but seven of these have only the IPO cohort and no business theme. Business-theme coverage is **2,604/2,612** under current code. Track business coverage and cohort coverage separately.
- **1,176 stocks lack sub-industry**. Neither the bridge nor issuer theme fallback supplies that source field. A mapped theme does not imply a mapped sub-industry.
- `ICICILIFE` is the remaining completely unmapped theme record. The pinned source has `ICICIPRULI` mapped to Life Insurance, and the retained symbol/ISIN map uses that older symbol. This suggests an identity-renaming gap; verify the security-master relationship before adding an explicit identity crosswalk. Fuzzy company-name matching would be inappropriate.
- The young cohort tests **available candle count**, because `historySessions = len(frame)`. It does not measure lifetime exchange sessions or IPO age. `DSKULKARNI`, with a 1995 listing date and 50 available sessions, qualifies. If this is intended as a resumed/short-history trading setup, name and document it accordingly. If it means a new listing, require the relevant listing-date/session evidence. The source's unused `recentNseListingDays: 300` rule also needs removal or implementation to avoid two contradictory definitions.
- Missing-data normalization differs: Rotation ignores `other`, `others`, `n/a`, and `unclassified`; copy/Earnings preserve most nonempty strings. Screen sector counts use `Others` for blank values. Centralize missing-value rules without deleting legitimate broad business groups such as Miscellaneous.
- Niche tags exist on 16 stocks in the snapshot. They do not establish thematic membership. Preserve this distinction, but expose their intended purpose if users are expected to discover them.

Evidence: [coverage calculation](https://github.com/Anny26022/nexus-scanner/blob/502104c7bd243d9d6d90a16b30c7144ecd65c573/frontend/theme_classification.py#L177), [cohort test](https://github.com/Anny26022/nexus-scanner/blob/502104c7bd243d9d6d90a16b30c7144ecd65c573/frontend/theme_classification.py#L163), [history count](https://github.com/Anny26022/nexus-scanner/blob/502104c7bd243d9d6d90a16b30c7144ecd65c573/frontend/snapshot_technicals.py#L15), [missing labels](https://github.com/Anny26022/nexus-scanner/blob/502104c7bd243d9d6d90a16b30c7144ecd65c573/frontend/rotation_history.py#L122), [screen counts](https://github.com/Anny26022/nexus-scanner/blob/502104c7bd243d9d6d90a16b30c7144ecd65c573/frontend/src/api/snapshotScreen.ts#L430).

## What is already handled well

Exact symbol joins avoid speculative company-name matching. Duplicate source and snapshot symbols fail closed. Primary company fields and raw provider labels remain distinct. The publisher produces a consolidated artifact with primary business fields and nested thematic detail. Issuer niche overlays are separate from theme-assignment evidence.

Rotation deduplicates primary/curated theme membership with a set, builds each stock's return once per group, retains historical constituents and dated liquidity eligibility, and dates membership changes from observation. Its tests verify that an overlap does not double-weight a stock within a group and that an expiring cohort preserves past returns. Minimum liquidity, three-member coverage, and history warm-up legitimately make its plotted universe smaller than a classification directory.

Membership before ledger observations is explicitly reconstructed from the earliest known labels. It should not be advertised as verified historical business exposure. The separate historical-snapshot generator also copies sector and industry from its supplied stock master; that path does not supply a dated taxonomy history by itself.

The screener's sector/industry choices and predicates use the same stock-row fields. Manual filtering and the AI filter catalogue share those choices. However, the catalogue does not expose theme/block/macro/sub-industry membership conditions, so theme-based screening is currently a capability gap relative to Rotation and grouping, rather than a second implementation of the same predicate.

Evidence: [dated ledger](https://github.com/Anny26022/nexus-scanner/blob/502104c7bd243d9d6d90a16b30c7144ecd65c573/frontend/rotation_history.py#L139), [historical spans](https://github.com/Anny26022/nexus-scanner/blob/502104c7bd243d9d6d90a16b30c7144ecd65c573/frontend/rotation_history.py#L169), [composite construction](https://github.com/Anny26022/nexus-scanner/blob/502104c7bd243d9d6d90a16b30c7144ecd65c573/frontend/rotation_history.py#L237), [filter choices](https://github.com/Anny26022/nexus-scanner/blob/502104c7bd243d9d6d90a16b30c7144ecd65c573/frontend/src/api/snapshotEngine.ts#L169), [screen predicates](https://github.com/Anny26022/nexus-scanner/blob/502104c7bd243d9d6d90a16b30c7144ecd65c573/frontend/src/api/snapshotScreen.ts#L137), [AI choices](https://github.com/Anny26022/nexus-scanner/blob/502104c7bd243d9d6d90a16b30c7144ecd65c573/frontend/src/api/aiFilterCatalog.ts#L48), [historical master fields](https://github.com/Anny26022/nexus-scanner/blob/502104c7bd243d9d6d90a16b30c7144ecd65c573/tools/generate_historical_snapshots.py#L784).

## Recommended consistent contract

Keep the dimensions distinct, and publish their relationships once in a versioned classification contract.

1. Give nodes stable IDs, labels, and explicit kinds: business sector, business industry, business theme, cross-cutting theme, cohort, aggregate, and alias. Separate old Tracker industry from primary industry by name. Renaming a label must not change membership identity.
2. Choose the primary business classification explicitly. Store theme participation as edges with theme ID, membership kind, basis, confidence, and effective/review dates. Keep source URLs in private evidence if the current public-payload policy requires it. Evidence basis must not decide whether a consumer honors an otherwise valid edge.
3. Publish stock-to-memberships and group-to-stock reverse indexes from the same resolver. Consumers should not reimplement membership eligibility from strings. Serialize Python-resolved projections for TypeScript consumers, or share cross-language contract fixtures to keep their behavior identical.
4. Define `primary business` and `all thematic participation` views. In the latter, a stock may appear once in each relevant theme. For combined selections, `ANY` means set union and `ALL` means set intersection. Global company totals count distinct securities. Overlapping group counts can exceed that total and should be labeled as participation counts.
5. Compute a block/macro union from the included business/thematic edges only when that view promises rollup. Deduplicate at each ancestor. Keep lifecycle cohorts separate. Never sum child counts or child composite indices to compute a parent: overlaps would double-count stocks. Build the parent directly from distinct constituent stocks.
6. Keep each thematic performance index equal-weighted over that group's eligible distinct stocks. Participation in a second theme should not dilute its first theme's membership weight. For an exclusive allocation chart, use the primary view or documented allocation weights; do not silently apply `1 / number of themes` to the existing Rotation model.
7. Make revision matching exact; distinguish classification absence from load failure. Build all projections atomically, validate their agreement, and record dated changes. Do not rewrite historical memberships simply to match today's labels.

For `CYIENTDLM`, the intended result is one explicit primary business theme, an additional Emerging EMS exposure, and the same two memberships wherever “all themes” is selected. It contributes once to each applicable group and once to any shared parent. Primary-business tables can still show its single primary classification.

## Implementation order and verification

First repair the inconsistent local release through the publisher and add an active-release integrity check. Then define the membership contract and update the frontend type, copy, and Earnings together. Add exact-revision handling and classification error states. Resolve mirror/aggregate targets and business-versus-overlay parent rules before widening multiple membership or enabling new theme filters. Finish by addressing coverage/identity gaps and age semantics with explicit evidence.

Existing focused verification passed: **24 Python tests and 26 Vitest tests**. Four temporary diagnostic probes also passed by reproducing the current gaps: secondary membership omitted by copy, omitted by Earnings, real current theme asset rejected, and missing historical revision returning latest taxonomy. These probes characterize current defects; they are not regression tests asserting the desired behavior. No live refresh or deployment was run.

Commands for the existing suites:

```sh
# Working directory: /Users/aniketmahato/Desktop/nexus-scanner/frontend
python3 -m unittest test_theme_classification test_rotation_history test_public_payload -v
npm test -- src/__tests__/themeAdapter.test.ts src/__tests__/copyResults.test.tsx src/__tests__/earnings.test.ts src/__tests__/rotation.test.ts src/__tests__/rotationTracker.test.tsx
```

The missing contract tests should cover the same multi-member security across every consumer; deduplication within themes and ancestors; ANY/ALL semantics; primary invariance to irrelevant source ordering; canonical alias resolution and aggregate handling; cohort expiry and insufficient age evidence; exact historical revision; errors versus genuine unmapped records; and agreement among every manifest-bound classification projection. Existing unit tests pass because they largely test each feature's current local contract rather than asserting cross-feature agreement.
