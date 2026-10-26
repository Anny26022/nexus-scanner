// The library build swaps this module for snapshotWorkerFactory.inline.ts, so a host bundler never has to resolve
// a worker file inside node_modules. The site keeps a separately cached worker file.
export const createSnapshotWorker = () => new Worker(new URL('./snapshot.worker.ts', import.meta.url), {type: 'module'});
