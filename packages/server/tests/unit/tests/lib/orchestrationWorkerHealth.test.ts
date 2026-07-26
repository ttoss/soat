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

// The standalone worker's liveness signal (orchestration-queue P2 tail). It has
// no HTTP listener, so its container healthcheck grades the freshness of a
// heartbeat file instead of hitting `/health`.
//
// A `lib/` test by the keep-list rule: there is no entry point — the producer is
// a background sweep and the consumer is the `workerHealthcheck` process
// entrypoint, neither reachable through REST/MCP.
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

  describe('writeWorkerHeartbeat', () => {
    test('publishes the last successful drain, creating missing directories', async () => {
      const at = Date.now();
      await writeWorkerHeartbeat({ lastSuccessfulDrainAtMs: at });

      expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({
        lastSuccessfulDrainAt: new Date(at).toISOString(),
      });
      expect((await readWorkerHeartbeat())?.getTime()).toBe(
        new Date(at).getTime()
      );
    });

    test('writes nothing before the first successful drain', async () => {
      await writeWorkerHeartbeat({ lastSuccessfulDrainAtMs: null });
      await expect(fs.readFile(file, 'utf8')).rejects.toThrow();
    });

    test('is a no-op when no heartbeat file is configured', async () => {
      delete process.env.ORCHESTRATION_WORKER_HEARTBEAT_FILE;
      await writeWorkerHeartbeat({ lastSuccessfulDrainAtMs: Date.now() });
      expect(await readWorkerHeartbeat()).toBeNull();
    });

    test('an unwritable path is swallowed rather than crashing the worker', async () => {
      // A path whose parent is an existing *file* can never be created.
      const blocker = path.join(dir, 'blocker');
      await fs.writeFile(blocker, 'x');
      process.env.ORCHESTRATION_WORKER_HEARTBEAT_FILE = path.join(
        blocker,
        'worker.heartbeat'
      );

      await expect(
        writeWorkerHeartbeat({ lastSuccessfulDrainAtMs: Date.now() })
      ).resolves.toBeUndefined();
      expect(await readWorkerHeartbeat()).toBeNull();
    });
  });

  describe('readWorkerHeartbeat', () => {
    test('is null when nothing has been published', async () => {
      expect(await readWorkerHeartbeat()).toBeNull();
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
      expect(await readWorkerHeartbeat()).toBeNull();
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
