import SnapshotWorker from './snapshot.worker.ts?worker&inline';

/** Library build only: the worker ships inside the package's JavaScript and starts from a blob URL. */
export const createSnapshotWorker = () => new SnapshotWorker();
