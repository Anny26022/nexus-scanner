# @anny26022/nexus-scanner

The embeddable scanner (`ScannerApp`). Versions follow semver: a host pins one version and upgrades on purpose.
Publishing: bump `version` in `frontend/package.json`, add an entry here, merge, then push the tag
`scanner-v<version>` (see `.github/workflows/publish-scanner-package.yml`).

## 0.1.0 — unreleased

- `ScannerApp` embedded mode: the scanner's own sidebar with a host `sidebarFooter`, host `theme` and `tokens`, `onOpenSymbol`, `onNavigateExternal`, namespaced
  storage, its own QueryClient, scoped CSS and portals, inline workers.
- `dataOrigin` / `apiOrigin` for cross-origin data and the AI endpoint.
- Controlled `tab`, `SCANNER_TABS`, `shareBaseUrl` and `sharedScreen` (`SCREEN_URL_PARAM`) for host routing and
  share links.
- `@anny26022/nexus-scanner/charts`: `PriceChart` (the scanner's chart engine, now also for intraday bars) and
  `CompareChart` (several series on one percentage scale), with a tokens-only `charts.css`.
