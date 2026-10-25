# Classification consistency: root causes, impact and PR intent

## Why this PR exists

A company participating in a second theme did not have the same membership everywhere in the product.
For example, CYIENTDLM had Industrial Systems & Controls as its primary theme and Emerging EMS as an
additional exposure. Rotation recognized both, while grouped copy and Earnings retained only the primary.
Parent rollups still followed the primary path. Selecting a theme therefore changed meaning depending on
which feature the user opened.

The PR establishes one versioned classification contract for publication and its consumers. Its intent is
to preserve supported business participation, make overlapping counts understandable, separate business
categories from cohorts and lookup unions, and prevent a missing or mismatched release from silently
changing classifications. It also records the taxonomy decisions needed to make that contract meaningful.

This is a correctness change affecting constituent selection and grouping. It is not an attempt to invent
a single official sector → industry → sub-industry → theme hierarchy, or to certify every issuer's business
from fresh filings. The primary company taxonomy and Tracker vocabulary have different authorities.
Their differences must be explicit rather than hidden behind identically named fields.

## Evidence and scope

The initial audit is preserved in `reports/taxonomy-membership-review-2026-10-24.md` and its JSON evidence.
Its observations belong to the recorded audit commit and frozen release, not to every subsequent build.
The implementation audit is `reports/classification-remediation-2026-10-25.json`; the maintained behavior
is defined in `docs/classification.md`.

The source review covered 3,410 Tracker rows, 313 original theme definitions, 28 blocks, 2,859 pinned
company records, 91 manual fallback classifications and 43 issuer assignments. The initial recomputation
produced 264 securities with multiple memberships, but 226 of the secondary memberships were the
IPO/Young Bases cohort. Treating that figure as 264 diversified businesses would be incorrect.

The initial local artifact audit also found a manifest/theme-file version mismatch: the manifest and
consolidated file named version `7ef33bbeee16…`, while the theme sidecar named `598e78dbc5c2…`.
Those two projections disagreed on 168 primary themes and 238 membership sets. The audit reproduced the
adapter rejection. It did not establish when or by whom those bytes diverged, or prove production served
the same broken combination. This PR adds a publication boundary check and active-artifact regression;
it does not attribute an unverified operational cause or rewrite historical classifications to today's rules.

## Root causes and how they propagated

### 1. A membership map existed without a shared consumer contract

`theme_classification.py` emitted both a primary scalar and a membership map. The shared frontend type
described scalar fields, grouped copy read `record.theme`, and the Earnings join explicitly selected only
the scalar fields. Those consumers discarded information before grouping. Rotation independently expanded
the map but honored secondary edges only when their basis string was `curated-rule`.

The causal gap was that primary display, thematic participation and evidence provenance were not separate
API concepts. A valid edge could disappear merely because its provenance label changed. Feature-level
tests passed because each feature asserted its own interpretation rather than cross-feature agreement.

**Correction:** one Python projection and one typed TypeScript accessor; publish complete `levels` arrays
and preserve the full record through joins. Primary scalars remain for compact display and compatibility.
All approved direct memberships participate regardless of their evidence label. Shared fixtures and
cross-consumer tests cover the same security, ANY/ALL matching and duplicate elimination.

### 2. Several different kinds of grouping occupied the same theme namespace

The old source put business categories, strategic overlays, aliases, multi-category unions and a listing
cohort into theme-shaped objects. `mirrorOf` described both one-target synonyms and multi-target unions.
Existence checks did not establish what a referenced node meant. Broad provider bridges could therefore
assign a mirror as if it were a narrow business, and synonymous groups could fragment peer comparisons.

**Correction:** explicit node kinds: business, exposure, alias, aggregate and cohort, plus stable registry
IDs. A true alias resolves to a canonical category. An aggregate has an explicit union and creates no new
business exposure parent. A deliberately broad primary remains broad instead of implying every leaf.
The registry now contains 316 nodes after defining three missing aggregates. Source definitions remain
preserved; reviewed interpretation is recorded in `classification_policy.json`.

### 3. Edge insertion order and destination flags controlled business meaning

The old assignment helper accepted an initial membership and then restricted later assignments using
`allowMultipleMembership`. Only five overlays had that flag. A first inserted overlay could suppress a
later business fallback; source iteration order could also determine an ambiguous fallback primary.
The initial audit found 35 active explicit-symbol candidates suppressed by that mechanism. Automatically
accepting all of them would have retained broad or obsolete lists, so this needed taxonomy review as well
as a code change.

**Correction:** primary selection happens independently of supplemental edges, with deterministic fallback
ordering. Reviewed secondary decisions can accept or remove imported edges without erasing a legitimate
primary. The policy records 39 overlap decisions: nine accepted and 30 declined. These include the original
candidates, non-active source candidates and two further EMS decisions. Counts are decisions about
supplemental edges, not the total number of memberships in the universe.

### 4. Parent scalars could not represent an overlapping graph

Blocks and macro pillars were derived only from the primary theme. Expanding the theme set in Rotation
did not expand its ancestors. Strategic overlays and IPO/Young Bases shared an Emerging Themes block
without a macro parent, even though they represented different kinds of relationship.

**Correction:** block and macro membership are distinct unions of actual business/exposure paths.
Multiple paths reaching one parent give a stock one constituent position. Parent composites are built
from distinct stocks rather than summed child composites. Four business overlays receive reviewed
business parents. Professional services receives its own macro pillar; general electrical capital goods
belongs to the industrial pillar. Cohorts do not participate in the business parent graph.

### 5. Available candle count was mistaken for listing age

`historySessions` measures retained observations. A suspended or long-listed stock with little available
history could qualify as IPO/Young Bases. The initial audit identified DSKULKARNI, listed in 1995, with
only 50 available sessions. Cohort-only records also inflated the reported business-mapping coverage.

**Correction:** the cohort requires 1–100 observed sessions and a valid listing date within 300 calendar
days of the snapshot, with no future dates. It expires independently of the business theme. Business and
cohort coverage are reported separately. Pharma - Small Cap is disabled because no approved dated size
rule exists; a static style name cannot establish a business exposure.

### 6. Identically named fields hid different classification authorities

The quote row's `industry` is the primary company industry. The thematic record's legacy `industry` is
Tracker's source industry. A general object spread could overwrite the former with the latter. Earnings
could additionally fall back to its feed's sector/industry when classification data was absent. The legacy
breadth builder grouped industry globally but selected its sector from the first encountered stock,
although industries can span multiple sectors.

**Correction:** explicit joins preserve primary company fields; thematic source fields are named and
retained separately. Reviewed company overrides run after the pinned extract while preserving provider
originals. The same published rows feed Charts, IPO labels and Market sector summaries. A cross-sector
industry reports its complete sector list and no arbitrary single parent. UI copy describes the actual
curated taxonomy rather than implying an official NSE hierarchy.

### 7. Failure, absence and historical substitution were conflated

Earnings checked pending classification requests but not errors, so a failed download could become an
Unclassified facet. Missing historical release lookup caught failures and returned the latest release,
which could validate successfully against its own taxonomy while violating the requested revision.
Missing-value handling also differed across features.

**Correction:** exact release matching, common missing-label rules and explicit retryable errors.
Unavailable mapping remains distinct from known non-membership. Three-valued filter evaluation preserves
unknowns under negation rather than matching a company merely because its classification is missing.

### 8. Publication and history had incomplete classification bindings

In-memory generation alone did not prove that every byte about to become active agreed. Classification
was not a first-class input to all joins or Rotation object validation. Historical backend evaluation
could load primary labels without the matching frozen thematic projection.

**Correction:** staged on-disk validation checks version, session, universe and primary/thematic projection
agreement before pointer activation. Backend revisions freeze the same classifications. Rotation indexes
name their classification version, and schema v2 consumers reject incompatible composites. Legacy six- and
seven-level membership ledgers migrate without dropping observations. Earlier memberships remain
reconstructions where no dated observations exist.

## User-facing capability gaps closed

Theme, thematic block, macro pillar, sub-industry, listing cohort and theme aggregate now have categorical
screen conditions, shared dynamic choices and AI catalog support. ANY performs membership union; ALL
requires every selected group. Grouped copy, Earnings and Rotation use the same memberships, although
their visible universes can legitimately differ because of earnings availability, liquidity, history and
indicator warm-up. Overlapping group totals must not be summed as an exclusive allocation.

The policy corrects specific alias/aggregate scopes, including API versus all Pharma and manufacturing EMS
versus consumer-electronics brands. Eleven issuer business reviews address outdated or absent mappings,
and the ICICIPRULI → ICICILIFE identity join is dated to its official effective date. Tata Technologies'
imported EMS overlay is rejected; Kaynes' documented EMS expansion is included. Individual reasons and
primary-source URLs are retained in the policy and audit.

## PR scope, rollout and remaining gaps

This PR is based on `main` after its weekly data refresh. It carries the classification implementation,
policy, tests and documentation. It deliberately does not replace `frontend/public/data/current.json`,
the latest consolidated data pointer, or current market payloads with the older local correction fixture.
Unrelated styling, company-scraping and Earnings data work are excluded.

After merge, normal snapshot publication generates schema v2 and matching Rotation composites from the
then-current data, freezes backend inputs, validates all staged projections and advances the pointer.
The offline rebuild tool is available for controlled frozen-data verification; it omits incompatible old
Rotation references and is not a substitute for a complete production publication. No deployment, remote
data upload or history rewrite is part of creating this PR. Retain the previous complete publication for
rollback rather than mixing new classification files into an old revision.

The verified earlier 23 October local correction mapped all 2,612 securities, including 48 with multiple
business memberships and 232 in the separate listing cohort. It retained 29 broad primaries and 1,168
unavailable sub-industries. These are source-quality limits, not evidence that all issuer details have
been independently researched. The local Rotation preview used prices through 9 October and displayed
that cutoff. Stable registry IDs do not automatically migrate existing label-keyed Rotation history;
future label renames still need an explicit migration. Historical sector/industry and pre-observation
memberships are not made point-in-time correct by this PR.

Validation covers the complete graph, shared cross-language fixture, actual active release (legacy or v2),
publisher output, deterministic primary selection, reviewed-edge rejection, alias/aggregate semantics,
cohort boundaries, unknowns/negation, parent deduplication, exact historical requests, Earnings failure
states and ledger migration. The initial implementation passed 1,755 frontend tests, 160 frontend Python
tests (two skipped), 530 pipeline tests (one skipped), frontend/worker TypeScript and production build.
The PR description records the checks rerun on the isolated branch against the newer `main` data.
