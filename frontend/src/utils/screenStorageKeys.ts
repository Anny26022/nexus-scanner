/**
 * The Screener persists its working state in these keys; a loaded screen replaces them.
 * Kept apart from saved-screen parsing so the small startup entry can read them without the filter catalogue.
 */
export const SCREEN_STORAGE_KEYS = {
  universe: 'nexus-scanner.screener.universe.v1',
  matchMode: 'nexus-scanner.screener.match-mode.v1',
  conditions: 'nexus-scanner.screener.conditions.v1',
  query: 'nexus-scanner.screener.query.v1',
  sort: 'nexus-scanner.screener.sort.v1',
  pagination: 'nexus-scanner.screener.pagination.v1',
  activeTab: 'nexus-scanner.ui.active-tab.v1',
} as const;
