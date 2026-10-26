// The library build swaps this module for studyWorkerFactory.inline.ts (see api/snapshotWorkerFactory.ts).
export const createStudyWorker = () => new Worker(new URL('./study.worker.ts', import.meta.url), {type: 'module'});
