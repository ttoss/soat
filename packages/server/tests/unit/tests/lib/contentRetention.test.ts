import { db } from 'src/db';
import { sweepExpiredTraceContent } from 'src/lib/contentRetention';
import { saveTrace } from 'src/lib/traces';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The retention sweep has no HTTP entry point — the scheduler tick is its only
 * caller — so it is tested directly against the real DB (tests.md keep-list,
 * case 2). Expiry is driven by an injected `now` rather than by backdating rows
 * or sleeping, per the TTL rule in tests.md.
 */
describe('sweepExpiredTraceContent', () => {
  let adminToken: string;
  let retainedProjectId: string;
  let disabledProjectId: string;
  let retainedProjectDbId: number;
  let disabledProjectDbId: number;
  let seq = 0;

  /** Wall-clock start of the run: every seeded trace is created "now", and the
   * sweep is handed a `now` far enough in the future to cross the window. */
  const seededAt = new Date();

  const futureNow = (daysAhead: number) => {
    return new Date(seededAt.getTime() + daysAhead * DAY_MS);
  };

  /** `saveTrace` resolves the agent within the trace's project, so every
   * project used here needs its own agent. Keyed by internal project id. */
  const agentByProject = new Map<number, { publicId: string; dbId: number }>();

  const agentFor = async (projectDbId: number) => {
    const existing = agentByProject.get(projectDbId);
    if (existing) return existing;

    const aiProvider = await db.AiProvider.create({
      projectId: projectDbId,
      name: `Retention Provider ${projectDbId}`,
      provider: 'openai',
      defaultModel: 'gpt-4o-mini',
    });
    const publicId = `agt_retention_${projectDbId}`;
    const agent = await db.Agent.create({
      publicId,
      projectId: projectDbId,
      aiProviderId: aiProvider.id,
      name: `Retention Agent ${projectDbId}`,
    });

    const created = { publicId, dbId: agent.id as number };
    agentByProject.set(projectDbId, created);
    return created;
  };

  const seedTrace = async (args: {
    projectDbId: number;
    projectPublicId: string;
    withGeneration?: boolean;
  }) => {
    seq += 1;
    const traceId = `trc_ret_${seq}_${seededAt.getTime()}`;
    const agent = await agentFor(args.projectDbId);

    await saveTrace({
      traceId,
      projectId: args.projectDbId,
      projectPublicId: args.projectPublicId,
      agentId: agent.publicId,
      steps: [{ type: 'text-delta', text: 'case content' }],
    });

    const row = await db.Trace.findOne({ where: { publicId: traceId } });

    let generationId: string | undefined;
    if (args.withGeneration) {
      generationId = `gen_ret_${seq}_${seededAt.getTime()}`;
      await db.Generation.create({
        publicId: generationId,
        projectId: args.projectDbId,
        agentId: agent.dbId,
        traceId: row!.id,
        status: 'completed',
        startedAt: seededAt,
        completedAt: seededAt,
        stopReason: 'stop',
        actionId: 'act_keepme',
        error: { message: 'boom' },
        metadata: { ticket_id: 'OPS-1' },
        pendingState: { messages: [{ role: 'user', content: 'secret' }] },
      });
    }

    return { traceId, traceDbId: row!.id as number, generationId };
  };

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'retentionadmin', password: 'supersecret' });
    adminToken = await loginAs('retentionadmin', 'supersecret');

    const retained = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Retention Project' });
    retainedProjectId = retained.body.id;

    const disabled = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'No Retention Project' });
    disabledProjectId = disabled.body.id;

    retainedProjectDbId = (await db.Project.findOne({
      where: { publicId: retainedProjectId },
    }))!.id as number;
    disabledProjectDbId = (await db.Project.findOne({
      where: { publicId: disabledProjectId },
    }))!.id as number;

    // Retention is opt-in: a project only has a window because it was set.
    const patched = await authenticatedTestClient(adminToken)
      .patch(`/api/v1/projects/${retainedProjectId}`)
      .send({ trace_content_retention_days: 30 });
    expect(patched.status).toBe(200);
    expect(patched.body.trace_content_retention_days).toBe(30);
  });

  test('a project with no retention window keeps its content forever', async () => {
    const seeded = await seedTrace({
      projectDbId: disabledProjectDbId,
      projectPublicId: disabledProjectId,
    });

    const purged = await sweepExpiredTraceContent({ now: futureNow(3650) });
    expect(purged).toBe(0);

    const row = await db.Trace.findByPk(seeded.traceDbId);
    expect(row!.contentRedactedAt).toBeNull();
    expect(row!.fileId).not.toBeNull();
  });

  test('leaves content that is still inside the window', async () => {
    const seeded = await seedTrace({
      projectDbId: retainedProjectDbId,
      projectPublicId: retainedProjectId,
    });

    const purged = await sweepExpiredTraceContent({ now: futureNow(29) });
    expect(purged).toBe(0);

    const row = await db.Trace.findByPk(seeded.traceDbId);
    expect(row!.contentRedactedAt).toBeNull();
    expect(row!.fileId).not.toBeNull();
  });

  test('purges content past the window and deletes the steps file', async () => {
    const seeded = await seedTrace({
      projectDbId: retainedProjectDbId,
      projectPublicId: retainedProjectId,
    });
    const before = await db.Trace.findByPk(seeded.traceDbId);
    const fileDbId = before!.fileId;
    expect(fileDbId).not.toBeNull();

    const purged = await sweepExpiredTraceContent({ now: futureNow(31) });
    expect(purged).toBeGreaterThanOrEqual(1);

    const row = await db.Trace.findByPk(seeded.traceDbId);
    expect(row!.contentRedactedAt).not.toBeNull();
    expect(row!.fileId).toBeNull();
    // The bytes, not just the pointer — a purge that leaves the object is the
    // fake erasure #835 closed.
    expect(await db.File.findByPk(fileDbId as number)).toBeNull();
  });

  test('stamps the sweep as the redacting principal, not a user', async () => {
    const seeded = await seedTrace({
      projectDbId: retainedProjectDbId,
      projectPublicId: retainedProjectId,
    });

    await sweepExpiredTraceContent({ now: futureNow(31) });

    const row = await db.Trace.findByPk(seeded.traceDbId);
    expect(row!.contentRedactedByPrincipalType).toBe('system');
    expect(row!.contentRedactedByPrincipalId).toBe('retention_sweep');
  });

  test('clears generation content but preserves the billing skeleton', async () => {
    const seeded = await seedTrace({
      projectDbId: retainedProjectDbId,
      projectPublicId: retainedProjectId,
      withGeneration: true,
    });

    await sweepExpiredTraceContent({ now: futureNow(31) });

    const gen = await db.Generation.findOne({
      where: { publicId: seeded.generationId! },
    });
    expect(gen!.metadata).toBeNull();
    expect(gen!.error).toBeNull();
    expect(gen!.pendingState).toBeNull();
    expect(gen!.contentRedactedAt).not.toBeNull();

    // Skeleton: everything billing and audit read must survive untouched.
    expect(gen!.status).toBe('completed');
    expect(gen!.stopReason).toBe('stop');
    expect(gen!.actionId).toBe('act_keepme');
    expect(gen!.startedAt).not.toBeNull();
  });

  test('does not re-stamp a trace it already purged', async () => {
    const seeded = await seedTrace({
      projectDbId: retainedProjectDbId,
      projectPublicId: retainedProjectId,
    });

    await sweepExpiredTraceContent({ now: futureNow(31) });
    const first = await db.Trace.findByPk(seeded.traceDbId);
    const firstStamp = first!.contentRedactedAt;

    const secondCount = await sweepExpiredTraceContent({ now: futureNow(60) });
    const second = await db.Trace.findByPk(seeded.traceDbId);

    expect(second!.contentRedactedAt).toEqual(firstStamp);
    // Already-redacted rows are filtered out of the due set, so a steady-state
    // sweep is not O(all history) on every tick.
    expect(secondCount).toBe(0);
  });

  test('applies each project its own window', async () => {
    const shortWindow = await seedTrace({
      projectDbId: retainedProjectDbId,
      projectPublicId: retainedProjectId,
    });

    const longRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Long Retention Project' });
    const longProjectDbId = (await db.Project.findOne({
      where: { publicId: longRes.body.id },
    }))!.id as number;
    await authenticatedTestClient(adminToken)
      .patch(`/api/v1/projects/${longRes.body.id}`)
      .send({ trace_content_retention_days: 365 });

    const longWindow = await seedTrace({
      projectDbId: longProjectDbId,
      projectPublicId: longRes.body.id,
    });

    await sweepExpiredTraceContent({ now: futureNow(40) });

    expect(
      (await db.Trace.findByPk(shortWindow.traceDbId))!.contentRedactedAt
    ).not.toBeNull();
    expect(
      (await db.Trace.findByPk(longWindow.traceDbId))!.contentRedactedAt
    ).toBeNull();
  });

  test('purges a whole run when its root expires, including newer children', async () => {
    // A run is one logical unit: `purgeTraceContent` cascades down the subtree,
    // so a child written minutes after its root goes with it. Leaving the child
    // would leave the same run's content readable by another path.
    seq += 1;
    const rootId = `trc_ret_root_${seq}_${seededAt.getTime()}`;
    const childId = `trc_ret_child_${seq}_${seededAt.getTime()}`;

    await saveTrace({
      traceId: rootId,
      projectId: retainedProjectDbId,
      projectPublicId: retainedProjectId,
      agentId: (await agentFor(retainedProjectDbId)).publicId,
      steps: [{ type: 'text-delta', text: 'root' }],
    });
    await saveTrace({
      traceId: childId,
      projectId: retainedProjectDbId,
      projectPublicId: retainedProjectId,
      agentId: (await agentFor(retainedProjectDbId)).publicId,
      steps: [{ type: 'text-delta', text: 'child' }],
      parentTraceId: rootId,
      rootTraceId: rootId,
    });

    await sweepExpiredTraceContent({ now: futureNow(31) });

    const child = await db.Trace.findOne({ where: { publicId: childId } });
    expect(child!.contentRedactedAt).not.toBeNull();
    expect(child!.fileId).toBeNull();
  });

  test('a partial batch still converges — the sweep drains the backlog', async () => {
    const seeded = await Promise.all([
      seedTrace({
        projectDbId: retainedProjectDbId,
        projectPublicId: retainedProjectId,
      }),
      seedTrace({
        projectDbId: retainedProjectDbId,
        projectPublicId: retainedProjectId,
      }),
      seedTrace({
        projectDbId: retainedProjectDbId,
        projectPublicId: retainedProjectId,
      }),
    ]);

    // A batch limit below the backlog must not silently drop the remainder.
    const purged = await sweepExpiredTraceContent({
      now: futureNow(31),
      batchLimit: 2,
    });
    expect(purged).toBeGreaterThanOrEqual(3);

    for (const item of seeded) {
      expect(
        (await db.Trace.findByPk(item.traceDbId))!.contentRedactedAt
      ).not.toBeNull();
    }
  });
});
