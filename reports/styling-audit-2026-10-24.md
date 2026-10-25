# CSS, Tailwind and design audit — 24 October 2026

## Scope and verdict

Inventoried all tracked styles and application modules. All authored CSS belongs to the React/Vite frontend: 12 stylesheets, with no additional Python/Worker styling system. Parsed CSS declarations/layers and literal JSX classes, built production assets, and inspected the principal screens and selected dialogs in Chromium.

The hybrid system is sound. Semantic light/dark tokens, shared primitives, Radix focus handling and base/components/utilities layering provide a useful foundation. Most stylesheet weight comes from authored feature rules, especially Charts and Screener. Tailwind utilities are not the principal source of bloat. The necessary work is deleting obsolete rules, giving shared styles clear ownership and correcting specific integration defects. A wholesale Tailwind conversion would add churn without demonstrated benefit.

The initial audit used commit `502104c7`. Before preparing this change, current main was fetched and the implementation rebased onto `9c281ea3`, which already includes the mobile Rotation layout from PR #150 and the publication changes from PR #149. The overlapping experimental mobile toggle/scroll changes were discarded. The existing phone layout and touch actions are preserved. Measurements below compare **current main with this follow-up**, using the same installed compiler and compression settings.

## Measurements

| Metric | Current main | After cleanup |
| --- | ---: | ---: |
| Authored CSS files | 12 | 12 |
| Authored CSS bytes | 258,135 | 246,170 |
| Authored CSS lines | 6,125 | 5,876 |
| Rule blocks | 2,045 | 1,952 |
| Declarations | 8,318 | 7,971 |
| CSS `!important` declarations | 64 | 44 |
| Identifiable JSX important utility occurrences | 25 | 5 |
| Initial production CSS, minified | 263,489 B | 224,830 B |
| Initial production CSS, gzip | 45,343 B | 38,645 B |
| Lazy Earnings CSS, minified / gzip | Included above | 17,355 B / 4,117 B |
| All CSS assets, minified / summed gzip | 263,489 B / 45,343 B | 242,185 B / 42,762 B |

Initial CSS transfer falls **14.8%**; total compressed transfer after opening Earnings falls **5.7%**. The latter sums the separately compressed assets because they are separate HTTP responses. Deferring Earnings accounts for part of the initial reduction; it is not deleted code. Vite's displayed gzip estimate differs slightly from Node's default `gzipSync`; the table consistently uses the latter.

Before cleanup, the initial bundle contained 211,757 B of custom component-layer rules (80.4%), 2,384 B of unlayered custom tokens/rules (0.9%), and 33,937 B of Tailwind utilities (12.9%). The remaining theme/base/framework/animation support mixes app and framework contributions. Charts and Screener account for roughly 57% of authored CSS bytes.

The final initial bundle contains 173,656 B of custom component rules and 33,379 B of utilities, plus the lazy Earnings component layer. JSX has 2,260 identifiable utility occurrences and 1,334 custom-class occurrences. These are literal source-fragment counts, not percentages of runtime styling: dynamic variants, passed class props and component-generated classes prevent a defensible single application-wide Tailwind percentage.

## Confirmed issues and changes

1. **Inactive News CSS shipped globally.** App remaps saved News sessions to Screener and has no production NewsTab import. Removed the CSS import; retained the component and shared news API used by CompanySnapshotCard. Corrected 18 undefined `--text-muted` references to the existing `--muted` token in the retained inactive stylesheet.
2. **Obsolete controls and accumulated overrides.** Removed 76 unused selectors covering old chart settings switches/sliders/fields, old chart status/date markup and the replaced session picker. Checked production templates and dynamic naming families. Consolidated 18 chart, six earnings and three screener selector groups while retaining effective declarations, media conditions and shorthand order. Preserved the effective 16px chart-settings radius, including the intervening generic modal override.
3. **Shared styles had multiple owners.** Moved SentimentBadge rules from the AI feature stylesheet into shared components and used semantic positive/negative/muted tokens. Added only the repeated Button sizes: compact text and square icon controls, both 28px with matching minimum height; default remains 32px. Replaced forced Rotation sizing and unnecessary logo important modifiers. Retained overrides needed for inline chart geometry, mobile controls and accessibility preferences.
4. **Standalone Earnings CSS loaded eagerly.** Imported it from its existing lazy component, preserving `@layer components`, its portal root `.ep-sheet`, mobile rules and zero-specificity scoping of generic state selectors. It no longer affects unrelated screens after being loaded.
5. **Popover shadow utility did not exist.** `--shadow-pop` is a normal CSS variable, not a utility-generating theme token. Replaced `shadow-pop` with `shadow-(--shadow-pop)` at the actual call site. Verified a nonzero computed shadow and the retained filter icon.
6. **Small RRG text reused plot colors with insufficient light-theme contrast.** Leading/weakening/improving are roughly 3.53:1 / 3.19:1 / 3.68:1 on white, below the normal-text 4.5:1 threshold. Canvas quadrant labels now use the existing muted text token at full opacity; tooltip quadrant text uses the text token. The small gaining/losing labels use secondary text. Plot/trail colors and colored markers remain available for recognition.
7. **Reduced-transparency rule targeted obsolete markup.** Replaced `.dialog::backdrop` with actual Radix and chart overlays, the sidebar and Rotation tooltip. Preference overrides disable blur and provide an opaque surface. Important declarations here deliberately override higher-layer utility styles.

## Decisions that avoid unnecessary changes

- **Preserve the already merged mobile fix.** At 390px, the retained chart is 360px wide with page gutters; Tracker uses its existing five-column phone layout and no document overflow. Desktop remains a rail and chart.
- **Keep Charts CSS shared.** Screener QuickChartsView consumes chart stage/action selectors, and Watchlist/responsive overrides cross feature boundaries. Moving the entire file to ChartsTab would break shared consumers or change the cascade. Splitting it requires a separately justified extraction; it is not a safe import-only cleanup.
- **Keep Tailwind detection unchanged.** The initial controlled scan considered 311 files versus 164 production-only files. Both independently compiled outputs were byte-identical. Narrowing detection saved zero CSS bytes, so no new source configuration was added.
- **Keep deliberate financial-data density and dynamic geometry.** The inventory found 27 font-size expressions, including responsive/hiding/variable values, plus inline chart geometry. They do not establish 27 independently broken design roles. No blanket typography rewrite, inline-style ban or chart virtualizer was introduced.
- **Use existing build reporting.** The frontend styling conventions now describe shared sizes, safe lazy loading and comparing initial versus lazy CSS. No new dependency, size-monitor framework or styling abstraction was needed.

## Design principles and remaining direction

Color semantics, theme support, chart data density and reusable primitives are coherent. The largest maintenance risk is cascade ownership in older feature files. Continue using Tailwind for ordinary layout, spacing and responsive state; retain custom CSS for tokens, complex reusable structures, canvas/SVG and third-party integration. When changing a control, delete its superseded rules and use the existing primitive/token vocabulary. Establish additional typography roles only when a concrete repeated use needs one.

Do not choose a target Tailwind percentage. Review visual hierarchy, legibility, focus/touch behavior and production asset size instead. CSS remains about 43 KB compressed across all feature assets after cleanup; this is a modest cached payload, not proof of a major rendering bottleneck. The existing large JavaScript chunk warning requires a separate dependency/runtime investigation and is not resolved by these CSS changes.

## Verification and limits

- Production build passes on current main plus the follow-up. All **1,714 frontend tests in 85 files pass**. Existing jsdom canvas warnings and Vite warnings remain; no new failure was hidden.
- Compared retained chart/settings/screener computed styles across desktop/mobile and light/dark on 236 representative elements; no differences. All 68 settled Earnings comparisons were identical; initial content-visibility timing artifacts were excluded by waiting for fonts and settled frames.
- Production browser checks covered lazy Earnings styling and its detail portal, 720px desktop / 370px phone chart-settings dialogs, 390px Rotation Chart/Tracker, light/dark rendering, the filter popover shadow and 28px Done button. Chromium emulation confirmed the actual reduced-transparency preference matches and removes backdrop blur.
- `git diff --check` passes. Snapshot/release data, ranking formulas and pipeline behavior are outside this change.

This is a complete authored-styling inventory with targeted interaction checks, not an accessibility certification or a security/financial-data audit. Browser CSS coverage was not used to claim unused percentages: Chromium's coarse layer ranges do not prove selector-level dead code.

Relevant standards: [Tailwind theme variables](https://tailwindcss.com/docs/theme), [source detection](https://tailwindcss.com/docs/detecting-classes-in-source-files), [WCAG text contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) and [target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).
