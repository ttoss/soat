import { db } from 'src/db';
import { recordComputeUsage } from 'src/lib/usageComputeRecording';

// Only the replay branch — the happy path is covered through real runs in
// `rest/usage.test.ts`. No entry point can drive it: every REST/scheduler path
// meters a given (run, node, attempt) at most once by construction.
describe('recordComputeUsage idempotency', () => {
  let projectId: number;
  let runPublicId: string;
  let orchestrationRunId: number;

  const countEvents = async (idempotencyKey: string): Promise<number> => {
    return db.UsageEvent.count({ where: { idempotencyKey } });
  };

  beforeAll(async () => {
    const project = await db.Project.create({
      name: 'Compute Idempotency Project',
    });
    projectId = project.id;

    const orchestration = await db.Orchestration.create({
      projectId,
      name: 'compute-idempotency',
      nodes: [{ id: 'xf', type: 'transform', expression: 1 }],
      edges: [],
    });
    const run = await db.OrchestrationRun.create({
      orchestrationId: orchestration.id,
      projectId,
      status: 'succeeded',
      state: {},
      activeNodes: [],
      artifacts: {},
    });
    orchestrationRunId = run.id;
    runPublicId = run.publicId;
  });

  test('a redelivered node execution writes no second event or component', async () => {
    const startedAt = new Date('2026-07-26T12:00:00.000Z');
    const completedAt = new Date('2026-07-26T12:00:02.500Z');
    const key = `compute:${runPublicId}:node:xf:attempt:1`;

    await recordComputeUsage({
      projectId,
      orchestrationRunId,
      runPublicId,
      nodeId: 'xf',
      attempt: 1,
      startedAt,
      completedAt,
    });

    expect(await countEvents(key)).toBe(1);
    const event = await db.UsageEvent.findOne({
      where: { idempotencyKey: key },
    });
    expect(event?.meterType).toBe('compute_execution');
    const componentsAfterFirst = await db.UsageComponent.count({
      where: { usageEventId: event?.id as number },
    });
    expect(componentsAfterFirst).toBe(1);

    // Replay the identical execution — the resolved key already exists, so the
    // event is left alone and no duplicate component is appended.
    await recordComputeUsage({
      projectId,
      orchestrationRunId,
      runPublicId,
      nodeId: 'xf',
      attempt: 1,
      startedAt,
      completedAt,
    });

    expect(await countEvents(key)).toBe(1);
    expect(
      await db.UsageComponent.count({
        where: { usageEventId: event?.id as number },
      })
    ).toBe(1);
  });

  test('a later retry attempt of the same node meters under its own key', async () => {
    const startedAt = new Date('2026-07-26T12:01:00.000Z');
    const completedAt = new Date('2026-07-26T12:01:01.000Z');

    await recordComputeUsage({
      projectId,
      orchestrationRunId,
      runPublicId,
      nodeId: 'xf',
      attempt: 2,
      startedAt,
      completedAt,
    });

    // attempt 2 is a distinct key, so it is real new work and is metered.
    expect(await countEvents(`compute:${runPublicId}:node:xf:attempt:2`)).toBe(
      1
    );
    expect(await countEvents(`compute:${runPublicId}:node:xf:attempt:1`)).toBe(
      1
    );
  });
});
