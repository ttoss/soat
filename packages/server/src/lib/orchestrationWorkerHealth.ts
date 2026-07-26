import fs from 'node:fs/promises';
import path from 'node:path';

import createDebug from 'debug';

const log = createDebug('soat:orchestrations');

const DEFAULT_HEARTBEAT_STALE_MS = 30_000;

/**
 * Where the worker publishes its liveness heartbeat. Unset means the process
 * writes no heartbeat — the default for the worker loop running inside the API
 * process, which is covered by the HTTP `/health` probe instead. A standalone
 * worker has no HTTP listener, so its container healthcheck reads this file.
 */
export const heartbeatFilePath = (): string | undefined => {
  return process.env.ORCHESTRATION_WORKER_HEARTBEAT_FILE || undefined;
};

/**
 * How old the heartbeat may be before the worker counts as unhealthy. Must
 * comfortably exceed `ORCHESTRATION_WORKER_INTERVAL_MS` (the heartbeat is
 * republished once per tick) or a healthy worker flaps.
 */
export const heartbeatStaleMs = (): number => {
  const configured = Number(
    process.env.ORCHESTRATION_WORKER_HEARTBEAT_STALE_MS
  );
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_HEARTBEAT_STALE_MS;
};

export type WorkerHeartbeat = { lastSuccessfulDrainAt: string };

/**
 * Publishes the worker's liveness: the timestamp of its last **successful**
 * queue claim, not merely of the last timer tick — a worker that keeps ticking
 * but can no longer reach the queue must go unhealthy rather than look alive.
 *
 * A no-op when no heartbeat file is configured, or before the first successful
 * drain (nothing to attest yet — the healthcheck reports the missing file as
 * unhealthy, which is correct during startup). The write goes to a temporary
 * file and is renamed into place so a reader never observes a half-written
 * file. Failures are logged and swallowed: an unwritable heartbeat must never
 * take down a worker that is otherwise draining fine — it surfaces as an
 * unhealthy container instead.
 */
export const writeWorkerHeartbeat = async (args: {
  lastSuccessfulDrainAtMs: number | null;
}): Promise<void> => {
  const filePath = heartbeatFilePath();
  if (!filePath || args.lastSuccessfulDrainAtMs === null) return;

  const payload: WorkerHeartbeat = {
    lastSuccessfulDrainAt: new Date(args.lastSuccessfulDrainAtMs).toISOString(),
  };
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(tempPath, JSON.stringify(payload), 'utf8');
    await fs.rename(tempPath, filePath);
  } catch (error) {
    log('writeWorkerHeartbeat: failed %o', error);
  }
};

/**
 * Reads the published heartbeat, or `null` when it is absent or unreadable
 * (missing file, truncated JSON, unexpected shape) — every one of which means
 * "no trustworthy liveness signal", which the caller treats as unhealthy.
 */
export const readWorkerHeartbeat = async (): Promise<Date | null> => {
  const filePath = heartbeatFilePath();
  if (!filePath) return null;
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { lastSuccessfulDrainAt } = parsed as Record<string, unknown>;
    if (typeof lastSuccessfulDrainAt !== 'string') return null;
    const at = new Date(lastSuccessfulDrainAt);
    return Number.isNaN(at.getTime()) ? null : at;
  } catch {
    return null;
  }
};

export type WorkerHealth = {
  healthy: boolean;
  reason: 'ok' | 'not_configured' | 'no_heartbeat' | 'stale';
  ageMs: number | null;
};

/**
 * The verdict a worker container's healthcheck acts on: healthy only when a
 * heartbeat exists and is younger than {@link heartbeatStaleMs}. An
 * unconfigured heartbeat file is reported as `not_configured` rather than
 * healthy — a healthcheck that cannot observe anything must not pass.
 */
export const checkWorkerHealth = async (args?: {
  now?: Date;
}): Promise<WorkerHealth> => {
  if (!heartbeatFilePath()) {
    return { healthy: false, reason: 'not_configured', ageMs: null };
  }
  const heartbeat = await readWorkerHeartbeat();
  if (!heartbeat) {
    return { healthy: false, reason: 'no_heartbeat', ageMs: null };
  }
  const now = args?.now ?? new Date();
  const ageMs = now.getTime() - heartbeat.getTime();
  if (ageMs > heartbeatStaleMs()) {
    return { healthy: false, reason: 'stale', ageMs };
  }
  return { healthy: true, reason: 'ok', ageMs };
};
