import 'dotenv/config';

import { checkWorkerHealth } from './lib/orchestrationWorkerHealth';

/**
 * Container healthcheck for the standalone orchestration worker
 * (`node dist/workerHealthcheck.mjs`).
 *
 * The worker serves no HTTP, so it cannot answer the API's `/health` probe.
 * Instead it publishes a heartbeat file after every successful queue claim and
 * this entrypoint grades that file's freshness: exit `0` when the worker
 * claimed from the queue recently, `1` otherwise (never started, wedged, or
 * unable to reach the queue). It opens no database connection of its own —
 * liveness is precisely "the worker process is still draining", which is what
 * the heartbeat attests.
 */
const main = async (): Promise<void> => {
  const health = await checkWorkerHealth();
  if (health.healthy) {
    process.exit(0);
  }
  process.stderr.write(
    `orchestration worker unhealthy: ${health.reason}${
      health.ageMs === null ? '' : ` (heartbeat age ${health.ageMs}ms)`
    }\n`
  );
  process.exit(1);
};

void main();
