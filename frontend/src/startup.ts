import { preloadManifest, manifestSnapshotSource } from './api/manifest';
import { startSnapshotWorker, runSnapshotTask } from './api/snapshotClient';

// The small entry starts data loading before importing the UI bundle.
if (import.meta.env.VITE_USE_MOCK !== 'true') {
  let screener = true;
  let etf = false;
  try { screener = [null, 'screener', 'news'].includes(JSON.parse(localStorage.getItem('nexus-scanner.ui.active-tab.v1') ?? 'null')); } catch {}
  try { etf = JSON.parse(localStorage.getItem('nexus-scanner.screener.universe.v1') ?? 'null') === 'etf'; } catch {}
  if (screener) startSnapshotWorker();
  void preloadManifest().then(manifest => screener
    ? runSnapshotTask({type:'warm', source:manifestSnapshotSource(manifest, undefined, undefined, etf)}) : undefined).catch(() => {
    // The normal query surfaces errors and retains its existing retry path.
  });
}
