import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  checkWorkerHealth,
  heartbeatFilePath,
  heartbeatStaleMs,
  readWorkerHeartbeat,
  writeWorkerHeartbeat,
} from 'src/lib/orchestrationWorkerHealth';

// The standalone worker has no HTTP listener, so its healthcheck grades the
// freshness of a heartbeat file. The grading is reached only from
// `src/workerHealthcheck.ts`, a separate process entry point no test drives;
// publishing the file is driven at the worker loop in
// `rest/orchestrationWorkerHeartbeat.test.ts`.
describe('orchestration worker heartbeat', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'soat-worker-hb-'));
    file = path.join(dir, 'nested', 'worker.heartbeat');
    process.env.ORCHESTRATION_WORKER_HEARTBEAT_FILE = file;
  });

  afterEach(async () => {
    delete process.env.ORCHESTRATION_WORKER_HEARTBEAT_FILE;
    delete process.env.ORCHESTRATION_WORKER_HEARTBEAT_STALE_MS;
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe('configuration', () => {
    test('the heartbeat path comes from the environment', () => {
      expect(heartbeatFilePath()).toBe(file);
    });

    test('an empty heartbeat path counts as unset', () => {
      process.env.ORCHESTRATION_WORKER_HEARTBEAT_FILE = '';
      expect(heartbeatFilePath()).toBeUndefined();
    });

    test('the staleness threshold defaults to 30s and is overridable', () => {
      expect(heartbeatStaleMs()).toBe(30_000);
      process.env.ORCHESTRATION_WORKER_HEARTBEAT_STALE_MS = '5000';
      expect(heartbeatStaleMs()).toBe(5000);
    });

    test('an invalid staleness threshold falls back to the default', () => {
      process.env.ORCHESTRATION_WORKER_HEARTBEAT_STALE_MS = 'soon';
      expect(heartbeatStaleMs()).toBe(30_000);
      process.env.ORCHESTRATION_WORKER_HEARTBEAT_STALE_MS = '-1';
      expect(heartbeatStaleMs()).toBe(30_000);
    });
  });

  describe('readWorkerHeartbeat', () => {
    test('is null when nothing has been published', async () => {
      expect(await readWorkerHeartbeat({ filePath: file })).toBeNull();
    });

    test.each([
      ['malformed json', 'not-json'],
      ['a json scalar', '42'],
      ['a missing timestamp', JSON.stringify({})],
      ['a non-string timestamp', JSON.stringify({ lastSuccessfulDrainAt: 1 })],
      [
        'an unparseable timestamp',
        JSON.stringify({ lastSuccessfulDrainAt: 'yesterday' }),
      ],
    ])('is null for %s', async (_label, contents) => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, contents);
      expect(await readWorkerHeartbeat({ filePath: file })).toBeNull();
    });
  });

  describe('checkWorkerHealth', () => {
    test('is healthy while the heartbeat is fresh', async () => {
      const now = new Date();
      await writeWorkerHeartbeat({
        lastSuccessfulDrainAtMs: now.getTime() - 1000,
      });

      expect(await checkWorkerHealth({ now })).toEqual({
        healthy: true,
        reason: 'ok',
        ageMs: 1000,
      });
    });

    test('is unhealthy once the heartbeat is older than the threshold', async () => {
      const now = new Date();
      await writeWorkerHeartbeat({
        lastSuccessfulDrainAtMs: now.getTime() - 45_000,
      });

      expect(await checkWorkerHealth({ now })).toEqual({
        healthy: false,
        reason: 'stale',
        ageMs: 45_000,
      });
    });

    test('is unhealthy before the worker has published anything', async () => {
      expect(await checkWorkerHealth()).toEqual({
        healthy: false,
        reason: 'no_heartbeat',
        ageMs: null,
      });
    });

    test('is unhealthy — not silently passing — when unconfigured', async () => {
      delete process.env.ORCHESTRATION_WORKER_HEARTBEAT_FILE;
      expect(await checkWorkerHealth()).toEqual({
        healthy: false,
        reason: 'not_configured',
        ageMs: null,
      });
    });

    test('grades against the configured staleness threshold', async () => {
      process.env.ORCHESTRATION_WORKER_HEARTBEAT_STALE_MS = '2000';
      const now = new Date();
      await writeWorkerHeartbeat({
        lastSuccessfulDrainAtMs: now.getTime() - 3000,
      });

      expect((await checkWorkerHealth({ now })).healthy).toBe(false);
      expect(
        (await checkWorkerHealth({ now: new Date(now.getTime() - 2000) }))
          .healthy
      ).toBe(true);
    });
  });
});
