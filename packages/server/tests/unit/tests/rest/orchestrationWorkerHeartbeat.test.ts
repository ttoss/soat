import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  drainQueueOnce,
  lastSuccessfulDrainAtMs,
  publishWorkerHeartbeat,
} from 'src/lib/orchestrationWorker';

/**
 * The heartbeat file a standalone worker publishes after a drain, driven at
 * the worker loop's own two sweeps: `drainQueueOnce`, then
 * `publishWorkerHeartbeat`. How the healthcheck grades the file is pinned in
 * `lib/orchestrationWorkerHealth.test.ts`; that a drain refreshes it, in
 * `rest/orchestrationQueue.test.ts`.
 */
describe('the worker heartbeat sweep', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'soat-worker-heartbeat-'));
  });

  afterEach(async () => {
    delete process.env.ORCHESTRATION_WORKER_HEARTBEAT_FILE;
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('publishes the last successful drain, creating missing directories', async () => {
    const file = path.join(dir, 'nested', 'worker.heartbeat');
    process.env.ORCHESTRATION_WORKER_HEARTBEAT_FILE = file;

    await drainQueueOnce();
    expect(await publishWorkerHeartbeat()).toBe(0);

    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({
      lastSuccessfulDrainAt: new Date(lastSuccessfulDrainAtMs()!).toISOString(),
    });
  });

  test('an unwritable heartbeat path leaves the worker running', async () => {
    // A path whose parent is an existing file can never be created.
    const blocker = path.join(dir, 'blocker');
    await fs.writeFile(blocker, 'x');
    process.env.ORCHESTRATION_WORKER_HEARTBEAT_FILE = path.join(
      blocker,
      'worker.heartbeat'
    );

    await drainQueueOnce();
    await expect(publishWorkerHeartbeat()).resolves.toBe(0);

    expect(await fs.readdir(dir)).toEqual(['blocker']);
    expect(await fs.readFile(blocker, 'utf8')).toBe('x');
  });
});
