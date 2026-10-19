import { createSnapshotEngine, type SnapshotTask } from './snapshotEngine';

const run = createSnapshotEngine();
const inFlightControllers = new Map<number, AbortController>();

export type WorkerMessage =
  | { type: 'cancel'; id: number }
  | { type?: undefined; id: number; task: SnapshotTask };

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const data = event.data;
  if (data.type === 'cancel') {
    const controller = inFlightControllers.get(data.id);
    if (controller) {
      controller.abort();
      inFlightControllers.delete(data.id);
    }
    return;
  }

  const { id, task } = data;
  const controller = new AbortController();
  inFlightControllers.set(id, controller);

  try {
    const result = await run(task, controller.signal);
    inFlightControllers.delete(id);
    self.postMessage({ id, result });
  } catch (error) {
    inFlightControllers.delete(id);
    const isAborted = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
    self.postMessage({
      id,
      error: isAborted ? 'Aborted' : (error instanceof Error ? error.message : 'Snapshot processing failed'),
    });
  }
};
