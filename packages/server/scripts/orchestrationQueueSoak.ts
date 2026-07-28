import 'dotenv/config';

import { initialize } from '@ttoss/postgresdb';

import * as dbModule from '../src/db';
import { buildDatabaseConfig, type DB } from '../src/db';
import {
  getOrchestrationQueueDriver,
  type OrchestrationQueueDriver,
  type QueueStats,
} from '../src/lib/orchestration-queue-drivers';
import { claimLatencySnapshot } from '../src/lib/orchestrationQueueMetrics';

/**
 * Load / soak harness for the orchestration queue (orchestration-queue P3).
 *
 * It exercises the **queue** — enqueue → claim → ack under a sustained backlog —
 * rather than node execution, so what it measures is the driver's throughput and
 * stability: how many tasks a fleet of simulated workers moves per second, how
 * far claim latency drifts, and whether the backlog and the leased-but-unacked
 * set stay bounded over the run instead of growing without limit.
 *
 * It talks to whatever `ORCHESTRATION_QUEUE_DRIVER` selects, so both drivers can
 * be compared on the same workload.
 *
 * ```bash
 * # 8 simulated workers draining a 5k backlog kept topped up for 60s
 * SOAK_BACKLOG=5000 SOAK_WORKERS=8 SOAK_DURATION_MS=60000 \
 *   pnpm --filter @soat/server queue-soak
 * ```
 *
 * | Variable            | Default | Meaning                                       |
 * | ------------------- | ------- | --------------------------------------------- |
 * | `SOAK_BACKLOG`      | `2000`  | Tasks seeded before the drain starts          |
 * | `SOAK_WORKERS`      | `4`     | Concurrent claim/ack loops                     |
 * | `SOAK_BATCH`        | `10`    | Tasks claimed per loop iteration               |
 * | `SOAK_DURATION_MS`  | `30000` | How long to sustain the workload               |
 * | `SOAK_PRODUCE_RATE` | `200`   | Tasks/second enqueued during the run (0 = off) |
 * | `SOAK_RUNS`         | `50`    | Distinct runs the tasks are spread across      |
 *
 * Exit code is non-zero when the queue fails the stability check (the backlog
 * at the end exceeds the backlog at the start while producers were slower than
 * the drain), so it can gate a release if a deployment chooses to run it.
 */

const num = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

const config = {
  backlog: num('SOAK_BACKLOG', 2000),
  workers: num('SOAK_WORKERS', 4),
  batch: num('SOAK_BATCH', 10),
  durationMs: num('SOAK_DURATION_MS', 30_000),
  produceRate: num('SOAK_PRODUCE_RATE', 200),
  runs: num('SOAK_RUNS', 50),
};

const sleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

const report = (line: string): void => {
  // A CLI script: stdout is the interface.
  // eslint-disable-next-line no-console
  console.log(line);
};

/**
 * Seeds the fixtures the queue points at: one project, one orchestration, and
 * `SOAK_RUNS` queued runs. Tasks reference a run, so a soak needs real rows even
 * though no node ever executes.
 */
const seedRuns = async (db: DB): Promise<number[]> => {
  const project = await db.Project.create({
    name: `queue-soak-${Date.now()}`,
    description: 'Ephemeral project created by the queue soak harness.',
  });
  const orchestration = await db.Orchestration.create({
    projectId: project.id as number,
    name: 'queue-soak',
    nodes: [{ id: 'noop', type: 'transform', expression: 1 }],
    edges: [],
  });

  const runIds: number[] = [];
  for (let i = 0; i < config.runs; i += 1) {
    const run = await db.OrchestrationRun.create({
      orchestrationId: orchestration.id as number,
      projectId: project.id as number,
      status: 'queued',
      state: {},
      activeNodes: [],
      artifacts: {},
      input: {},
    });
    runIds.push(run.id as number);
  }
  return runIds;
};

type SoakCounters = {
  produced: number;
  drained: number;
  claimFailures: number;
};

/**
 * Producer: keeps the backlog topped up so the drain is measured under
 * sustained arrival, not just a one-shot burst.
 */
const runProducer = async (args: {
  driver: OrchestrationQueueDriver;
  pickRun: (index: number) => number;
  deadline: number;
  counters: SoakCounters;
}): Promise<void> => {
  if (config.produceRate === 0) return;
  const intervalMs = 100;
  const perTick = Math.max(
    1,
    Math.round((config.produceRate * intervalMs) / 1000)
  );
  while (Date.now() < args.deadline) {
    for (let i = 0; i < perTick; i += 1) {
      await args.driver.enqueue({
        orchestrationRunId: args.pickRun(args.counters.produced + i),
        kind: 'continue',
      });
    }
    args.counters.produced += perTick;
    await sleep(intervalMs);
  }
};

/**
 * Consumer: one simulated worker process. It acks immediately — node execution
 * is deliberately out of scope, the queue itself is what is under test.
 */
const runConsumer = async (args: {
  driver: OrchestrationQueueDriver;
  deadline: number;
  counters: SoakCounters;
}): Promise<void> => {
  while (Date.now() < args.deadline) {
    let tasks;
    try {
      tasks = await args.driver.claim({ limit: config.batch });
    } catch (error) {
      args.counters.claimFailures += 1;
      report(`claim failed: ${String(error)}`);
      await sleep(100);
      continue;
    }
    if (tasks.length === 0) {
      await sleep(50);
      continue;
    }
    await Promise.all(
      tasks.map(async (task) => {
        await args.driver.ack({ task });
      })
    );
    args.counters.drained += tasks.length;
  }
};

/** Prints the run's summary and returns whether the drain kept up. */
const reportOutcome = (args: {
  counters: SoakCounters;
  elapsedMs: number;
  before: QueueStats;
  after: QueueStats;
}): boolean => {
  const { counters, elapsedMs, before, after } = args;
  const latency = claimLatencySnapshot();

  report('');
  report(`elapsed:            ${(elapsedMs / 1000).toFixed(1)}s`);
  report(`drained:            ${counters.drained} task(s)`);
  report(`produced (in-run):  ${counters.produced} task(s)`);
  report(
    `throughput:         ${(counters.drained / (elapsedMs / 1000)).toFixed(1)} task/s`
  );
  report(`claim latency p50:  ${latency.p50 ?? 'n/a'} ms`);
  report(`claim latency p95:  ${latency.p95 ?? 'n/a'} ms`);
  report(`queue depth:        ${before.queueDepth} → ${after.queueDepth}`);
  report(`leased (unacked):   ${after.claimedTasks}`);
  report(`claim failures:     ${counters.claimFailures}`);

  // Stability: with the drain outpacing arrivals, the backlog must shrink. A
  // backlog that grew means the queue could not keep up at this rate — the
  // signal a soak exists to produce.
  const keptUp =
    counters.drained >= counters.produced &&
    after.queueDepth <= before.queueDepth;
  report('');
  report(
    keptUp
      ? 'STABLE: the drain kept up with arrivals.'
      : 'UNSTABLE: backlog grew.'
  );
  return keptUp;
};

const main = async (): Promise<void> => {
  const db = await initialize(buildDatabaseConfig());
  // The lib modules read the shared `db` binding rather than receiving one.
  (dbModule as { db: DB }).db = db;

  const driver = getOrchestrationQueueDriver();
  report(`driver: ${driver.name}`);
  report(`config: ${JSON.stringify(config)}`);

  const runIds = await seedRuns(db);
  const pickRun = (index: number): number => {
    return runIds[index % runIds.length];
  };

  report(`seeding a backlog of ${config.backlog} task(s)…`);
  for (let i = 0; i < config.backlog; i += 1) {
    await driver.enqueue({ orchestrationRunId: pickRun(i), kind: 'continue' });
  }

  const startedAt = Date.now();
  const deadline = startedAt + config.durationMs;
  const before = await driver.stats();
  const counters: SoakCounters = { produced: 0, drained: 0, claimFailures: 0 };

  await Promise.all([
    runProducer({ driver, pickRun, deadline, counters }),
    ...Array.from({ length: config.workers }, () => {
      return runConsumer({ driver, deadline, counters });
    }),
  ]);

  const elapsedMs = Date.now() - startedAt;
  const after = await driver.stats();
  const keptUp = reportOutcome({ counters, elapsedMs, before, after });

  await db.sequelize.close();
  process.exit(keptUp && counters.claimFailures === 0 ? 0 : 1);
};

void main();
