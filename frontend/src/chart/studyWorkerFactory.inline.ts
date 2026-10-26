import StudyWorker from './study.worker.ts?worker&inline';

/** Library build only: the worker ships inside the package's JavaScript and starts from a blob URL. */
export const createStudyWorker = () => new StudyWorker();
