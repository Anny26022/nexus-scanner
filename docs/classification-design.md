# Classification design

Status: proposal, 25 October 2026. No code has changed. This document replaces no existing behaviour until
it is implemented in phases (see [Rollout](#13-rollout)).

## 1. Purpose

Every Nexus surface must mean the same thing by a classification label: Screener filters, AI filters, Results
copy/export, Earnings, Rotation, Market, Charts, IPO and the chart directory. Beyond consistency, the goal is
**granularity no one else has**: each listed company placed in the exact niche it earns money from, with the
share of its business that niche represents, the evidence for it, and the date it was true.

## 2. What exists today

Seven classification sources feed the app. None is authoritative on its own.

| Source | Vocabulary | Coverage (23 Oct release, 2,612 stocks) | Role today |
| --- | --- | --- | --- |
| StockScans export (pinned 14 Oct) | 106 sectors, 482 industries | 2,250 | Primary sector/industry |
| Dhan / provider (`provider_sector`, `provider_industry`) | 50 sectors, 209 industries | 2,510 | Fallback bridge only |
| Manual overrides (`taxonomy_overrides.json`) | StockScans vocabulary | 91 | Override primary |
| Theme Tracker source | Themes → blocks → macro pillars, plus its own industry and sub-industry | 2,367 | Themes everywhere |
| Web-research overrides, scanner→theme bridge | Tracker themes | 43 | Theme fallback |
| Proprietary niche tags | Free text | 16 | Screener only |
| NSE four levels (`nse_l1…l4`, coded) | Macro → Sector → Industry → Basic industry | 306 (from the earnings feed only) | Unused |
| Company overviews (`the_read`) | Prose, often with revenue mix | 2,422 | Unused for classification |
| IPO provider | Its own sector | 2,352 | IPO page |
| NSE sectoral and thematic indices (`indexMemberships`) | 50 indices (Nifty Pharma, IT, Chemicals, EV & New Age Auto…) | 837 | Screener filter only |
| IPO provider records (`ipodecode_ipo_data.json`, `ipo_provider_data.json`) | One sector per issue; the `segments` field means Mainboard/SME, not business segments | 2,352 | IPO page |
| Classified filings (90-day catalog plus per-company history) | 64 topics: acquisitions, divestments, capex, order wins… | 1,212 stocks filed in the last 90 days | Screener filter, filings panel |

### 2.1 Our proprietary thematic taxonomy

The Nexus "deep niche thematic segregation" (nexusjournal.co.in; pinned 4 Aug 2026, content unchanged since):
6 macro pillars → 28 thematic blocks → 313 themes, plus 3,410 company rows with sector, industry (196), theme,
sub-industry (282), provenance and curated secondary themes.

- **Theme kinds are mixed together.** 93 themes are mirrors or unions of others, 5 allow multiple membership, 1 is
  hidden (AI Infra & GPU Cloud), and 1 is a listing cohort (IPO / Young Bases, inside the Emerging Themes block).
- **Row quality varies.** Of the 2,367 rows for current-universe stocks, only 574 are `reference_full`; 982 are
  `reference_partial`, 697 are `csv_fallback`, and 85 are StockScans-derived or reviewed listings.
- **Coverage gaps.** 245 current stocks have no row and fall back to web research (43 assignments) or a 74-rule
  scanner-industry bridge. 1,043 rows belong to symbols no longer in the universe.
- **Unused vocabulary.** Only 206 of the 313 themes are any current stock's primary theme.
- Other variations in the codebase: niche assignments (5) and niche tags (16) with a review queue (2), the Rotation
  merge of curated emerging themes into the Themes level, and PR #159's unmerged policy (316 nodes, 39 overlap
  decisions).

### 2.2 Tijori company overviews

The company overviews (`frontend/public/data/company`) come from the Tijori cache (`reference/tijori`, refreshed
18 Oct): 2,423 narrative overviews with `the_read`, `what_to_watch` and `key_events`; 178 companies have none and 3
are unmapped. There are no Tijori sector or industry fields. **1,185 overviews state an explicit "% of revenue"
figure**, the best available input for revenue-weighted niches, though the claims are unverified narrative.

## 3. What is wrong (measured on the live 23 Oct release)

1. **Industries are not nested.** 122 industry labels occur under more than one sector ("IT Services" under IT
   Software and E-Commerce; "Diversified" under five sectors). Grouping by industry merges unrelated companies.
2. **Catch-all labels hide 386 companies.** Trading (74), Miscellaneous (64), Finance and Investments Others (24),
   Finance Holding Company (20), Diversified (14) and similar carry no business meaning.
3. **Providers disagree on about 300 companies** beyond naming differences: 290 stocks whose Dhan industry is
   atypical for their StockScans industry, 289 for sector, 335 between our industry and the Tracker's.
4. **Two fields are called "industry".** The Tracker's industry differs from the company industry for 2,367
   stocks; a careless join overwrites one with the other.
5. **The same name means different things at different levels.** 10 theme names equal sector names (Cement,
   Fertilizers, Railways…) and 31 equal industry names. Everything is matched by display string.
6. **"Multiple membership" is mostly a cohort.** 264 stocks have more than one membership; 233 of those are the
   IPO / Young Bases cohort. About 31 are genuine secondary business exposures.
7. **Consumers interpret memberships differently.** Copy and Earnings read the primary theme only; Rotation reads
   secondary edges only when their provenance string is `curated-rule`; Market (PR #151) counts the cohort as a
   theme. Blocks and pillars follow the primary theme only.
8. **Proprietary niches are unchecked and undated.** Of the 16 niche-tagged companies, several conflict with the
   company's own current description (see §11).
9. **Historical sessions silently use today's classifications.** Old `/data/revisions/<rev>/release.json` files are
   not served (the app's HTML page is returned), so the app falls back to the latest release.

### 3.1 Full cross-check (every source)

Re-run on 25 October against every source above: StockScans, Dhan, manual overrides, the full Tracker (provenance,
blocks, pillars), web research, niche tags, NSE sectoral and thematic indices, IPO sector, the complete Tijori text
(`the_read`, `what_to_watch`, `key_events`) and the last 90 days of classified filings.

| Check | Result |
| --- | --- |
| Tijori text supports the company industry (word overlap) | 1,648 of 2,194 (75%) |
| Tijori text supports our primary theme, by Tracker provenance | `reference_full` 75%, `reference_partial` 74%, `csv_fallback` 64%, StockScans-derived 62–75%, **no Tracker row 57%** |
| Hand check of 25 random "unsupported" themes | 18 correct (synonym misses), **5 wrong**, 2 catch-alls |
| NSE sectoral index vs our labels | Clean for Auto, Bank, Energy, FMCG, IT, Metal, Pharma, Realty, Capital Markets; disagreements in Consumer Durables (5), EV & New Age Auto (9), Chemicals (3) are mostly NSE using broader scopes (fertilisers in Chemicals, tiles and footwear in Durables) |
| IPO provider sector vs ours | No atypical pairs |
| Blocks and pillars | Every primary theme has a block; 7 stocks sit in a block with no macro pillar (the Emerging Themes block) |
| Stated revenue shares in Tijori | 1,183 stocks; a naive extractor also captures customer and geography shares ("61% with the public sector", "95% Gujarat"), so segment weights need a proper parser |
| Filing topics, last 90 days (2,929 filings) | Of 96 "Acquisition" tags, 53 are SAST holding disclosures and 26 are only the generic exchange subject line; one "Order win" is a contract **rescission**; 79% of statuses are "unspecified" |

What this means:

- **Primary themes are wrong for roughly 5–8% of companies** (about 150–200), concentrated where there is no Tracker
  row or the row is a `csv_fallback`. Examples from the hand check: JUBLCPL (theme Rice & Grain Processing; business is
  performance polymers and chemicals, ~63% of revenue), FORCEMOT (Passenger Cars; mainly LCVs, vans and buses), Bilcare
  (Specialized Equipment & Retail; pharma packaging), BirlaNu (Furniture & Decor; flooring, roofing, pipes and
  building products), Cheviot (Home Textiles; jute goods).
- **Company industry is directionally right for about three in four companies,** but catch-alls (269 after excluding
  specific "Finance …" labels) and provider disputes (555 distinct stocks) remain.
- **NSE indices are a reliable cross-check for the large sectors** and a useful scope signal for thematic ones.
- **Filing topics cannot yet drive re-review.** The classifier must first separate holding disclosures, generic subject
  lines and cancellations (§6.1).
- **The review backlog is at most about 1,160 distinct companies** (union of every signal). Most word-overlap flags are
  synonyms, so the realistic queue is closer to 500–600.

The manifest/theme-file version mismatch recorded in PR #159's audit was caused by a stray data commit in PR #148
that was reverted before merge; the live release is consistent today.

## 4. Principles

1. **Three separate axes**, never mixed in one namespace: what the company *is* (identity), what it *earns from or
   is exposed to* (exposures), and *dated states* (cohorts and attributes).
2. **No provider is the authority.** Providers are evidence. Agreement raises confidence; disagreement opens a
   review. Our own reviewed decision is the authority, and it cites its evidence.
3. **Every assignment carries weight, date and evidence.** A niche without a revenue share, an as-of date and a
   source is a guess.
4. **Identity is a tree; exposures are a graph.** A company has exactly one identity path. It can have many weighted
   exposures, and parents are unions counted once per company.
5. **IDs, not names.** Every node has a stable, level-qualified ID (`ind:cranes-material-handling`,
   `thm:cement`). Names are display only and can change without breaking history.
6. **Unknown is not "no".** Missing classification is reported as unavailable, never as a match or a non-match.
7. **One compiled artifact, one accessor.** Features never build their own category lists.

## 5. The model

### 5.1 Identity: one canonical path per company

A Nexus-owned hierarchy of five levels:

| Level | Example (Action Construction Equipment) | Notes |
| --- | --- | --- |
| Macro | Industrials | About 12 nodes |
| Sector | Capital Goods | About 25 |
| Industry | Construction & Material-Handling Equipment | About 70; unique within its sector |
| Sub-industry | Mobile Cranes | About 250 |
| **Niche** | Pick-and-carry cranes | Open-ended, our differentiator |

Rules:

- **Exactly one path per company**, chosen by **current revenue share** (latest annual segment note; quarterly if
  the mix has shifted materially). Ties break by operating profit, then order book.
- **Crosswalks, not adoption.** NSE's four levels, StockScans, Dhan and the Tracker industry each get a mapping table
  from their labels or codes to our nodes. NSE codes are the strongest anchor where available because they are
  official and properly nested, but NSE's Basic Industry stops short of the niche level we want.
- **Catch-alls are not allowed as a final assignment.** "Trading", "Miscellaneous" and "Diversified" become review
  items until a specific node is evidenced (for example, Aarey Drugs: Pharmaceuticals → APIs, with chemical trading as
  a secondary exposure).
- **Holding companies and shells** get explicit nodes ("Investment holding", "Business wound down") rather than the
  industry of a former business (for example, MMTC).

### 5.2 Exposures: weighted, dated edges

An exposure edge links a company to a theme node:

```json
{"node": "thm:solar-epc", "basis": "order_book", "weight": 0.88, "asOf": "2026-06-30",
 "status": "emerging", "evidence": [{"type": "rhp", "url": "…", "excerpt": "…"}], "review": "accepted"}
```

- `basis` is one of `revenue`, `order_book`, `capacity`, `assets` or `stated_strategy`. A revenue edge describes the
  business today; an order-book or capacity edge describes where it is heading.
- `status` is `core`, `emerging`, `declining` or `wound_down`. Wound-down edges stay in history but are excluded from
  current screens.
- **Threshold:** an edge appears in current screens when its weight is at least 10%, or at least 5% if it is
  `emerging` with order-book or capacity evidence. Lower weights are kept for search but not grouping.
- Themes roll up to thematic blocks and macro pillars through the theme graph. A company's block and pillar
  memberships are the **union of its edges' parents, counted once**.
- **Proprietary niche tags become exposure edges** under the same rules, so there is one exposure system.
- Aliases resolve to one canonical theme. Aggregates (unions of themes) are explicit and never create an exposure.

### 5.3 States: cohorts and attributes

Dated, computed facts kept out of both trees: listing cohort (IPO / young base: listed within 300 days with at most
100 observed sessions), size bucket, liquidity tier, F&O, surveillance. Each has a rule, an as-of date and an expiry.

## 6. Evidence and resolution

The classifier is an evidence pipeline, not a lookup table.

1. **Collect.** For each company, gather every source label (NSE codes, StockScans, Dhan, Tracker, IPO provider),
   the overview's revenue mix, and classified filings (segment results, investor presentations, acquisitions,
   divestments, new subsidiaries, order wins).
2. **Crosswalk.** Map each source label to candidate identity nodes through the crosswalk tables.
3. **Score.**
   - **Auto-accept** when at least two independent sources map to the same node and the overview text supports it.
   - **Review** when sources disagree, the result is a catch-all, the overview contradicts the label, or a recent
     filing signals change (acquisition, divestment, new segment, discontinued operation).
4. **Research (review items).** Read, in this order: the latest annual-report segment note, quarterly segment results,
   investor presentation, RHP/DRHP for recent listings, then the company website and reputable broker notes.
   Record the revenue share, the period, and the URL plus excerpt. Web search is used to find these primary sources,
   not as evidence itself.
5. **Decide and record.** Write the decision (identity node, exposure edges with weights) with its evidence and date
   to the policy file. A reviewer's decision always outranks providers.
6. **Re-open automatically** when a classified filing indicates business change, when the revenue mix shifts by more
   than 10 points, or when a decision is older than 18 months.

Expected first pass: about 2,000 companies auto-accepted and 500–600 review items (see §3.1), starting with
companies that have no Tracker row or a `csv_fallback` row, then catch-alls, then provider disputes.

### 6.1 Inputs that must be fixed first

- **Revenue-share extraction.** Parse Tijori text and segment notes into typed shares: business segment, product,
  customer, geography, channel. Only business-segment and product shares can weight identity or exposures.
- **Filing topics.** Before filings can re-open a classification, the filing classifier must stop tagging SAST holding
  disclosures and generic "Reg 30 – Acquisition" subject lines as acquisitions, and must treat rescissions and
  cancellations as the opposite of an order win.
- **NSE coverage.** Fetch the coded four-level classification for the full universe; the earnings feed covers only 306.
- **Dhan fields.** Keep Dhan's quote sector and its fundamentals sector/industry as separate sources; today they are
  merged into one `provider_sector`.

## 7. Published contract

One artifact per release, `classification.json` (schema 3), bound to the release by version and session:

```json
{
  "schemaVersion": 3, "version": "<sha256>", "asOfDate": "2026-10-23",
  "nodes": {"ind:mobile-cranes": {"level": "subIndustry", "name": "Mobile Cranes", "parent": "ind:construction-equipment"},
            "thm:solar-epc": {"kind": "business", "name": "Solar EPC", "block": "blk:renewables"}},
  "records": {
    "ACE": {
      "identity": ["mac:industrials", "sec:capital-goods", "ind:construction-equipment", "sub:mobile-cranes", "nic:pick-and-carry"],
      "exposures": [{"node": "thm:cranes", "basis": "revenue", "weight": 0.94, "asOf": "2026-03-31"},
                    {"node": "thm:tractors", "basis": "revenue", "weight": 0.06, "asOf": "2026-03-31"}],
      "states": {"cohort": null},
      "sources": {"nse": "…", "stockscans": ["Capital Goods Non Electrical Equipment", "…"], "dhan": ["Automobiles", "…"]},
      "confidence": "reviewed", "reviewedOn": "2026-10-25"
    }
  }
}
```

The compiler validates the whole graph before publishing: every node reachable, no cycles, unique IDs, exactly one
identity path per company, weights between 0 and 1, every reviewed decision with evidence and a date.

## 8. Consumers

One accessor, `labels(record, level)` and `memberships(record, level, {current})`, implemented once in TypeScript and
once in Python against the **same shared test fixture**. Every consumer uses it:

| Surface | Uses |
| --- | --- |
| Screener and AI filters | Identity levels and exposures, ANY/ALL, three-valued (unknown stays unknown) |
| Results copy / export | Group by any level; a company appears under each of its exposures |
| Earnings | Breakdown by any level, exposures counted once per group |
| Rotation | Composites per node ID; the ledger keyed by ID |
| Market | Sector and theme summaries from the same records |
| Charts, chart directory, IPO | Display the identity path and top exposures |
| Company detail | Full identity path, weighted exposures with evidence links, history of changes |

Overlapping groups must never be summed as if they were exclusive; the UI says so where counts are shown.

## 9. History and point in time

- Every derived artifact (Rotation composites, Market overview, screens) records the classification version it used.
- The membership ledger is keyed by node ID and stores dated changes, so renames never break history.
- Every historical release publishes its own manifest and classification to R2. A missing release is shown as
  unavailable, never replaced by the latest.
- Classifications before the first observation are reconstructions and are labelled as such.

## 10. Governance and quality

- **Policy file** of decisions: identity overrides, accepted/declined exposure edges, each with reason, evidence URL,
  excerpt and date. Generated audit reports live outside the repository.
- **CI checks**: graph validation, cross-language fixture, no catch-all final assignments, no undated or unevidenced
  reviewed decision, the active release bound correctly.
- **Quality metrics** published with each release: coverage by level, review backlog, catch-all count, provider
  agreement rate, share of decisions older than 18 months.
- **Failure behaviour**: if the classification fails validation, publish the release with classification disabled and
  a visible notice, and keep prices fresh. Never activate mismatched classification files.

## 11. Pilot findings

From the cross-source check of the live release (§3.1), the company's own Tijori description, and web research on the
cited primary sources for ABREL, ACE, Aarey Drugs and Armee:

| Company | Sources say | Evidence | Decision |
| --- | --- | --- | --- |
| Aditya Birla Real Estate (ABREL) | StockScans: Realty; Dhan: Paper | Real estate about 85% of FY26 continuing revenue; pulp and paper sold to ITC (discontinued) | Identity: Real estate → Residential & commercial development. Paper exposure `wound_down`. Dhan stale. |
| Action Construction Equipment (ACE) | StockScans: Capital Goods Non-Electrical; Dhan: Automobiles | Cranes, material handling and construction equipment about 94% of revenue; agri equipment about 6% | Identity: Construction & material-handling equipment → Mobile cranes. Tractors exposure 6%. |
| Aarey Drugs (AAREYDRUGS) | StockScans: Trading; Dhan: Pharmaceuticals | Bulk-drug (API) manufacturer that also trades chemicals and solvents; one reported segment | Identity: Pharmaceuticals → APIs. Chemical trading exposure (weight to be extracted from filings). |
| Armee Infotech (ARMEE) | StockScans: IT Software; our web theme: Solar EPC | IT infrastructure about 86% of FY26 revenue; renewables about 88–90% of order book | Identity: IT infrastructure services. Solar EPC exposure, `emerging`, basis order book. Our current primary theme is wrong. |
| Ausom Enterprise (AUSOMENT) | Niche tag: Bullion trading | Sold traded gold and silver until FY25 | Bullion trading edge `wound_down`. Tag is stale. |
| MMTC | Niche tag: Precious metals refining (JV) | Trading wound down; income mostly interest and dividends | Identity: Investment holding / business wound down. Refining JV as a minority exposure only. |
| CMPDI | Niche tags: Coal, Mineral exploration | Consultancy for exploration and mine planning | Identity: Mining services → Exploration & mine-planning consultancy. Remove the "Coal" producer tag. |
| JUBLCPL | Theme: Rice & Grain Processing; industry: Specialty Chemicals | Performance polymers and chemicals about 63% of FY26 revenue | Theme is wrong. Identity: Specialty chemicals → Performance polymers. |
| Force Motors (FORCEMOT) | Theme: Passenger Cars | LCVs, vans, multi-utility vehicles, buses; engines and axles for other OEMs | Identity: Commercial vehicles → LCVs & vans. Engine supply as an exposure. |
| Bilcare (BI) | Theme: Specialized Equipment & Retail (healthcare) | Pharma packaging through Caprihans; clinical services | Identity: Packaging → Pharma packaging. |
| BirlaNu (BIRLANU) | Theme: Furniture & Decor | Flooring, roofing, pipes and water tanks, wall blocks and panels, coatings | Identity: Building materials → Building products (multi-category). |
| Cheviot (CHEVIOT) | Theme: Home Textiles & Furnish | Jute goods, a single segment | Identity: Textiles → Jute products. |
| SEPC | Filing topic: Order win | Rescission of seven water-supply contracts | Filing classifier error; must be a contract cancellation, not an order win. |

## 12. Relation to PR #159

Keep: separation of primary display from memberships, node kinds, parents as unions counted once, the dated listing
cohort, exact release binding, three-valued ANY/ALL screening, the publication-time consistency check, and one
accessor in both languages.

Change before merging:

1. Historical sessions: publish historical manifests and classifications first, or mark them unavailable; removing the
   fallback otherwise breaks every historical session.
2. Imported `curatedThemes` must be review candidates, not automatic memberships.
3. Choose the primary theme by evidence (revenue weight), not alphabetical order.
4. A classification mismatch must disable classification for that release, not halt the whole publish.
5. Consumers must match by node ID, not display name.
6. Rebase onto main (PR #157 already carries part of it), move PR #151 (Market) and PR #158 (Earnings) onto the
   accessor, and run the full CI.

Out of scope for #159, handled by this design: the identity hierarchy (§5.1), weighted and dated exposures (§5.2),
the evidence pipeline (§6), and folding niche tags into exposures.

## 13. Rollout

1. **Stabilise (PR #159, revised).** Apply §12, keep today's labels, ship the accessor and contract.
2. **Identity tree and crosswalks.** Build the canonical hierarchy and the crosswalk tables; auto-accept agreements;
   publish schema 3 alongside schema 2 for one release, then switch consumers.
3. **Review queue.** Fix the inputs in §6.1, then work the 500–600 review items using §6: companies with no Tracker
   row or a `csv_fallback` row first, then catch-alls, then provider disputes. Within each group, start with Nifty 500
   names so the most-viewed companies are right first.
4. **Exposures and niches.** Migrate themes and niche tags to weighted, dated edges; extract revenue mix from
   overviews and segment filings.
5. **Continuous upkeep.** Filing-driven re-review, quality metrics on each release, and a company-detail view that
   shows the evidence.

## 14. Open questions

1. Should NSE's coded hierarchy be fetched for the full universe (it is available per security), so every company
   has an official anchor rather than only the 306 seen in the earnings feed?
2. Which surfaces should show forward-looking exposures (order book, capacity) by default, and which only current
   revenue?
3. Who reviews: a fixed weekly budget of review items, and a second reviewer for Nifty 500 decisions?
4. How much revenue-mix extraction can be automated from the overviews and segment notes before human review?
