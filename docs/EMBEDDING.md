# Embedding the scanner in another React app

Nexus Journal (and any other React 19 host) can render the scanner UI natively through the
`@anny26022/nexus-scanner` package. nexus-scanner stays the source of truth: the EDL pipeline, GitHub
Actions refreshes, R2 bucket, the `nexus-scanner-data` Worker and the `nexus-scanner` Worker are unchanged,
and the standalone site at https://nexus-scanner.aniketmahato26.workers.dev keeps working exactly as before.

The host's browser fetches data **directly from Cloudflare**, never through the host's own server (Vercel
would bill that bandwidth).

## How data reaches an embedded scanner

| Request | Served by | Cross-origin access |
| --- | --- | --- |
| `/data/current.json` and relative `/data/revisions/<rev>/...` files | `nexus-scanner` static assets | `frontend/public/_headers` sends `Access-Control-Allow-Origin: *` (and exposes `Content-Encoding`) for `/data/*` |
| `https://nexus-scanner-data.../releases/...`, `/objects/...`, `/daily/...` | `nexus-scanner-data` Worker (R2) | already `Access-Control-Allow-Origin: *` |
| `POST /api/screener/ai-compile` | `nexus-scanner` Worker | only origins listed in `ALLOWED_ORIGINS` (`wrangler.jsonc`), plus same-origin |

`ScannerApp`'s `dataOrigin` prop (or `VITE_SCANNER_DATA_ORIGIN` at build time) is the origin every
root-relative URL resolves against: the pointer itself and every relative URL inside it. Absolute URLs (R2)
are used as published. The default is the page's own origin, so the standalone site still requests
`/data/current.json`.

The snapshot choice is unchanged: browsers with `DecompressionStream` (every current browser) read
`datasetPackedGzipUrl` (~3 MB), falling back to `datasetGzipUrl`; the ~25 MB plain `stocks.json` is used only
where decompression is unavailable. This is the same logic as standalone.

This is consistent with [RELEASE_STORAGE_PLAN.md](RELEASE_STORAGE_PLAN.md): no revision file, URL, hash input,
schema, formula or retention changes. When releases later move behind a same-origin R2 proxy, the
`/data/*` CORS rule must move with them.

## Installing in the host

The package is published (manually, not by CI) to GitHub Packages. In the host repository add `.npmrc`:

```
@anny26022:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

`GITHUB_PACKAGES_TOKEN` is a token with `read:packages` (set it in Vercel's environment as well). Then:

```bash
npm install @anny26022/nexus-scanner
```

Peer dependencies: `react@^19`, `react-dom@^19`, `@tanstack/react-query@^5`.

To publish a version: bump `version` in `frontend/package.json`, add an entry to `frontend/CHANGELOG.md`,
merge, then push the tag `scanner-v<version>`. `.github/workflows/publish-scanner-package.yml` checks that the
tag matches the version, runs the tests, builds `dist-lib/`, runs `npm run check:lib` and publishes. Nothing
publishes without that tag. CI builds and checks the package on every frontend PR.

## Using it

```tsx
import { ScannerApp } from '@anny26022/nexus-scanner';
import '@anny26022/nexus-scanner/style.css';

const SCANNER = 'https://nexus-scanner.aniketmahato26.workers.dev';

export function ScannerPage() {
  const theme = useJournalTheme(); // 'light' | 'dark'
  return (
    <div style={{height: 'calc(100dvh - var(--journal-header-height))'}}>
      <ScannerApp
        embedded
        dataOrigin={SCANNER}
        apiOrigin={SCANNER}
        theme={theme}
        storageNamespace="journal-scanner"
        onOpenSymbol={symbol => { openJournalChart(symbol); return true; }}
        onNavigateExternal={path => { /* e.g. sync the host URL; return true to cancel the switch */ }}
        style={{height: '100%'}}
      />
    </div>
  );
}
```

| Prop | Meaning |
| --- | --- |
| `dataOrigin` | Origin serving `/data/...`. Default: the host page's origin. |
| `apiOrigin` | Origin of the AI Worker. Default: `dataOrigin`. |
| `theme` | `'light'` or `'dark'`, owned by the host. |
| `tokens` | Overrides for the scanner's design tokens (`--page`, `--surface`, `--text`, `--accent`, `--line`, `--font-sans`, …), so it takes the host's palette and fonts. Values may reference the host's own CSS variables, e.g. `hsl(var(--background))`. Applied to the root and the popup container. |
| `sidebarFooter` | Rendered at the foot of the scanner sidebar in place of its appearance toggle, e.g. the host's view and theme switcher. |
| `onOpenSymbol(symbol)` | Called when the user opens a symbol (Market, Earnings, Rotation, command palette). Return `true` if the host handled it; otherwise the scanner opens its own Charts tab. |
| `onNavigateExternal(path)` | Called with `/<tab>` (`/screener`, `/charts`, ...) before each tab switch. Return `true` to cancel the internal switch. The scanner never touches `window.history` when embedded. |
| `storageNamespace` | Prefix for every localStorage key (default `nexus-scanner-embed`). |
| `queryClient` | Optional. By default the scanner creates its own client, so it never shares a cache with the host. |
| `tab` | Controlled tab, e.g. from a `/scanner/:tab` route (validate with `SCANNER_TABS`). The scanner reports each switch through `onNavigateExternal` and shows the tab the host passes back. |
| `shareBaseUrl` | Absolute URL of the host's scanner page. "Copy share link" then builds `<shareBaseUrl>?screen=…`. |
| `sharedScreen` | The `screen` query value of an opened share link (`SCREEN_URL_PARAM`), applied once at mount. It makes the Screener the working tab; the host routes to it and removes the parameter from its URL. |

Embedded mode renders the scanner exactly as the standalone site lays it out: its own sidebar (a top bar on
phones) and a full-height workspace. Mount it on a page that hides the host's own chrome, as Theme Tracker does
in Nexus Journal.

Origins and the namespace are read when the component mounts (re-key it to change them). Only one
`ScannerApp` may be mounted at a time.

## Charts only: `@anny26022/nexus-scanner/charts`

The scanner's chart engine, without the rest of the app, for hosts that only need charts (Nexus Journal's Theme
Tracker). It is a separate build: about 42 kB gzipped of JavaScript plus a 1 kB stylesheet of design tokens, with
`react` and `lightweight-charts` as its only imports. It does not need React Query or the scanner's data layer.

```tsx
import { PriceChart, CompareChart, type Candle } from '@anny26022/nexus-scanner/charts';
import '@anny26022/nexus-scanner/charts.css';

<div style={{height: 320}}>
  <PriceChart candles={candles} theme="dark" movingAverages={[{period: 20}, {period: 50}]} visibleBars={120} />
</div>
<div style={{height: 320}}>
  <CompareChart series={[{id: 'defence', label: 'Defence', points: [{date: '2026-10-01', value: 100}, …]}]} />
</div>
```

| Component | Props |
| --- | --- |
| `PriceChart` | `candles` (oldest first; `date` is a trading day `2026-10-26` or an ISO timestamp `2026-10-26T09:15:00Z` for intraday bars), `chartStyle` (`candles`, `bars`, `line`, `area`, …), `movingAverages` (`{period, color?}[]`), `showVolume` (default true), `visibleBars`, `onHover(bar)` |
| `CompareChart` | `series` (`{id, label, points: {date, value}[], color?}[]`, each rebased to 0% on the latest common start date), `onHover({date, values})` |
| Both | `theme` (`light` / `dark`), `tokens` (design-token overrides, e.g. `{'--surface': 'hsl(var(--card))'}`), `className`, `style`, `aria-label` |

Each chart fills its container, so the host sets the height. `rebaseSeries` and `COMPARE_PALETTE` are exported for
legends drawn outside the chart.

## Styles

`style.css` is precompiled: it contains every utility the scanner uses, its own Tailwind preflight, element
defaults and design tokens, all rewritten under `.nexus-scanner-root` at build time (`frontend/lib/scopeCss.ts`).

- **Do not add an `@source` line** for this package to the host's Tailwind config. The host's Tailwind would
  then generate the scanner's class names unscoped, with the host's theme values, and they would compete with
  the scoped ones. Importing `style.css` is all that is needed.
- Every style rule is scoped under `.nexus-scanner-root`, so the host's `html`, `body` and elements are
  untouched. Only names stay global: `@property --tw-*` registrations (identical to the host's own Tailwind
  v4) and `@keyframes` names (Tailwind's `spin`/`ping`/`pulse`/`bounce`, tw-animate's `enter`/`exit`, and
  the scanner's own, such as `ep-fade`). Dialogs, popovers and hover cards render into one `<div class="nexus-scanner-root
  nexus-scanner-portal">` appended to `<body>`, which carries the same scope and theme.
- The scanner sets `data-theme` on its own root and portal container, never on `<html>`.
- The reverse is not isolated: unlayered host CSS that targets bare elements (e.g. `a { color: … }`) beats the
  scanner's layered styles. Keep such host rules in a Tailwind layer or scoped to the host's own layout.

## Workers and CSP

The snapshot and chart-study Web Workers are inlined into the package and start from a `blob:` URL (falling
back to a `data:` URL), so the host's bundler never has to resolve worker files inside `node_modules`. A host
with a Content Security Policy must allow `worker-src blob: data:` and `connect-src` to the scanner and
`nexus-scanner-data` origins.

## AI endpoint allowlist

`workers/screener-ai/index.ts` keeps same-origin behaviour and additionally accepts the exact origins in
`ALLOWED_ORIGINS` (comma-separated; `*` is ignored). Allowed callers get `Access-Control-Allow-Origin: <origin>`
and `Vary: Origin` on every response (errors included) and a `204` preflight. Unlisted origins get `403` before
the body is read or the per-IP rate limiter is touched. Production lists `https://www.nexusjournal.co.in` and
`https://nexusjournal.co.in`; `wrangler.dev.jsonc` lists local Vite dev origins.

## Staging on branch previews (nothing reaches production)

Merging to `main` deploys `nexus-scanner` through Workers Builds, so the PR stays unmerged until the embed is
complete. Each pushed branch gets a preview at `https://<branch>-nexus-scanner.aniketmahato26.workers.dev`.
The `previews` block in `wrangler.jsonc` gives previews the AI binding, their own rate-limit namespace and an
allowlist with local dev origins and `https://*-aniketmahatobcom23-thceduins-projects.vercel.app` (Nexus
Journal's Vercel branch previews). A `*` entry matches only https hosts ending in the text after it; production
keeps exact origins.

During development the journal points `dataOrigin`/`apiOrigin` at the scanner preview URL and installs the
package from an `npm pack` tarball committed to its branch (`"@anny26022/nexus-scanner": "file:vendor/…tgz"`),
so nothing is published either.

## Deploy order

1. Deploy `nexus-scanner` (`npm run deploy` at the repository root) so `/data/*` gets CORS headers and the AI
   Worker gets `ALLOWED_ORIGINS`.
2. Verify from the host origin: `fetch('https://nexus-scanner.aniketmahato26.workers.dev/data/current.json')`.
3. Publish the package and install it in the host.

## Known limits

- The chart workspace's expanded mode and phone layout use the whole viewport.
- The historical-evaluation fallback (`VITE_API_BASE_URL`) is not affected by `apiOrigin`.
