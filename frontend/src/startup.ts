import { readStored } from './storage/store';
import { SCREEN_STORAGE_KEYS } from './utils/screenStorageKeys';
import { preloadManifest, manifestSnapshotSource } from './api/manifest';
import { startSnapshotWorker, runSnapshotTask } from './api/snapshotClient';

// The small entry starts data loading before importing the UI bundle.
if (import.meta.env.VITE_USE_MOCK !== 'true') {
  let screener = true;
  let etf = false;
  screener = [null, 'screener', 'news'].includes(readStored<unknown>(SCREEN_STORAGE_KEYS.activeTab, null) as string | null);
  etf = readStored<unknown>(SCREEN_STORAGE_KEYS.universe, null) === 'etf';
  if (screener) startSnapshotWorker();
  void preloadManifest().then(manifest => screener
    ? runSnapshotTask({type:'warm', source:manifestSnapshotSource(manifest, undefined, undefined, etf)}) : undefined).catch(() => {
    // The normal query surfaces errors and retains its existing retry path.
  });
}
