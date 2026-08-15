import { db } from 'src/db';
import {
  createGenerationRecord,
  updateGenerationRecord,
} from 'src/lib/generations';
import { clearTraceContentModeCache } from 'src/lib/traceContentPolicy';
import { recordTraceError, saveTrace } from 'src/lib/traces';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * Zero-retention suppresses content at the write chokepoints (`saveTrace`,
 * `createGenerationRecord`, `updateGenerationRecord`). Those seams are reached
 * from a real generation only, which the unit suite mocks at the LLM boundary —
 * so they are driven directly against the real DB (tests.md keep-list, case 2).
 * The REST-visible half (the fields and their validation) is covered in
 * `rest/projects.test.ts` and `rest/agents.test.ts`.
 */
describe('zero-retention mode', () => {
  let adminToken: string;
  let storingProjectId: string;
  let zeroProjectId: string;
  let storingProjectDbId: number;
  let zeroProjectDbId: number;

  /** Agent under a storing project, itself storing. */
  let storingAgent: { publicId: string; dbId: number };
  /** Agent under a storing project that tightened itself to `none`. */
  let tightenedAgent: { publicId: string; dbId: number };
  /** Agent under a zero-retention project (inherits `none`). */
  let inheritedAgent: { publicId: string; dbId: number };

  let seq = 0;

  const makeAgent = async (args: {
    projectDbId: number;
    suffix: string;
    traceContentMode?: string | null;
  }) => {
    const aiProvider = await db.AiProvider.create({
      projectId: args.projectDbId,
      name: `ZR Provider ${args.suffix}`,
      provider: 'openai',
      defaultModel: 'gpt-4o-mini',
    });
    const publicId = `agt_zr_${args.suffix}`;
    const agent = await db.Agent.create({
      publicId,
      projectId: args.projectDbId,
      aiProviderId: aiProvider.id,
      name: `ZR Agent ${args.suffix}`,
      traceContentMode: args.traceContentMode ?? null,
    });
    return { publicId, dbId: agent.id as number };
  };

  const seedTrace = async (args: {
    projectDbId: number;
    projectPublicId: string;
    agentPublicId: string;
  }) => {
    seq += 1;
    const traceId = `trc_zr_${seq}_${Date.now()}`;
    await saveTrace({
      traceId,
      projectId: args.projectDbId,
      projectPublicId: args.projectPublicId,
      agentId: args.agentPublicId,
      generationId: 'gen_test_steps',
      steps: [{ type: 'text-delta', text: 'confidential case content' }],
    });
    const row = await db.Trace.findOne({ where: { publicId: traceId } });
    return { traceId, row: row! };
  };

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'zradmin', password: 'supersecret' });
    adminToken = await loginAs('zradmin', 'supersecret');

    const storing = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'ZR Storing Project' });
    storingProjectId = storing.body.id;

    const zero = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'ZR Zero Project' });
    zeroProjectId = zero.body.id;

    storingProjectDbId = (await db.Project.findOne({
      where: { publicId: storingProjectId },
    }))!.id as number;
    zeroProjectDbId = (await db.Project.findOne({
      where: { publicId: zeroProjectId },
    }))!.id as number;

    const patched = await authenticatedTestClient(adminToken)
      .patch(`/api/v1/projects/${zeroProjectId}`)
      .send({ trace_content_mode: 'none' });
    expect(patched.status).toBe(200);
    expect(patched.body.trace_content_mode).toBe('none');

    storingAgent = await makeAgent({
      projectDbId: storingProjectDbId,
      suffix: 'storing',
    });
    tightenedAgent = await makeAgent({
      projectDbId: storingProjectDbId,
      suffix: 'tightened',
      traceContentMode: 'none',
    });
    inheritedAgent = await makeAgent({
      projectDbId: zeroProjectDbId,
      suffix: 'inherited',
    });

    clearTraceContentModeCache();
  });

  describe('saveTrace', () => {
    test('a storing agent writes the steps file, unchanged', async () => {
      const seeded = await seedTrace({
        projectDbId: storingProjectDbId,
        projectPublicId: storingProjectId,
        agentPublicId: storingAgent.publicId,
      });

      expect(seeded.row.fileId).not.toBeNull();
      expect(seeded.row.contentRedactedAt).toBeNull();
      expect(seeded.row.stepCount).toBe(1);
    });

    test('an agent tightened to none never writes the steps file', async () => {
      const seeded = await seedTrace({
        projectDbId: storingProjectDbId,
        projectPublicId: storingProjectId,
        agentPublicId: tightenedAgent.publicId,
      });

      expect(seeded.row.fileId).toBeNull();
      // Not merely absent from the row: never created. A File row would mean
      // bytes on disk, which is exactly what this mode promises not to do.
      const files = await db.File.findAll({
        where: { path: `/traces/${seeded.traceId}.json` },
      });
      expect(files).toHaveLength(0);
    });

    test('an agent inheriting a zero-retention project never writes the file', async () => {
      const seeded = await seedTrace({
        projectDbId: zeroProjectDbId,
        projectPublicId: zeroProjectId,
        agentPublicId: inheritedAgent.publicId,
      });

      expect(seeded.row.fileId).toBeNull();
    });

    test('the skeleton survives and is stamped as never-stored', async () => {
      const seeded = await seedTrace({
        projectDbId: zeroProjectDbId,
        projectPublicId: zeroProjectId,
        agentPublicId: inheritedAgent.publicId,
      });

      // The row exists — a zero-retention run is still auditable and still
      // attributable for billing; only its content is absent.
      expect(seeded.row.publicId).toBe(seeded.traceId);
      expect(seeded.row.agentId).toBe(inheritedAgent.dbId);
      expect(seeded.row.contentRedactedAt).not.toBeNull();
      expect(seeded.row.contentRedactedByPrincipalType).toBe('system');
      expect(seeded.row.contentRedactedByPrincipalId).toBe('zero_retention');
    });

    test('step_count is still recorded — it is a counter, not content', async () => {
      seq += 1;
      const traceId = `trc_zr_count_${seq}_${Date.now()}`;
      await saveTrace({
        traceId,
        projectId: zeroProjectDbId,
        projectPublicId: zeroProjectId,
        agentId: inheritedAgent.publicId,
        generationId: 'gen_test_steps',
        steps: [{ type: 'a' }, { type: 'b' }, { type: 'c' }],
      });

      const row = await db.Trace.findOne({ where: { publicId: traceId } });
      expect(row!.stepCount).toBe(3);
      expect(row!.fileId).toBeNull();
    });
  });

  describe('generation content columns', () => {
    const makeGeneration = async (args: {
      projectDbId: number;
      projectPublicId: string;
      agent: { publicId: string; dbId: number };
    }) => {
      const seeded = await seedTrace({
        projectDbId: args.projectDbId,
        projectPublicId: args.projectPublicId,
        agentPublicId: args.agent.publicId,
      });
      seq += 1;
      const publicId = `gen_zr_${seq}_${Date.now()}`;

      await createGenerationRecord({
        publicId,
        projectId: args.projectDbId,
        agentId: args.agent.publicId,
        traceId: seeded.traceId,
        metadata: { ticket_id: 'CASE-42', note: 'confidential' },
      });

      return publicId;
    };

    test('a storing agent persists metadata as before', async () => {
      const publicId = await makeGeneration({
        projectDbId: storingProjectDbId,
        projectPublicId: storingProjectId,
        agent: storingAgent,
      });

      const gen = await db.Generation.findOne({ where: { publicId } });
      expect(gen!.metadata).toEqual({
        ticket_id: 'CASE-42',
        note: 'confidential',
      });
      expect(gen!.contentRedactedAt).toBeNull();
    });

    test('caller metadata is not persisted in zero-retention mode', async () => {
      const publicId = await makeGeneration({
        projectDbId: zeroProjectDbId,
        projectPublicId: zeroProjectId,
        agent: inheritedAgent,
      });

      const gen = await db.Generation.findOne({ where: { publicId } });
      expect(gen!.metadata).toBeNull();
      expect(gen!.contentRedactedAt).not.toBeNull();
      expect(gen!.contentRedactedByPrincipalId).toBe('zero_retention');
    });

    test('error, extraction and pendingState updates are dropped', async () => {
      const publicId = await makeGeneration({
        projectDbId: storingProjectDbId,
        projectPublicId: storingProjectId,
        agent: tightenedAgent,
      });

      await updateGenerationRecord({
        publicId,
        status: 'requires_action',
        stopReason: 'tool-calls',
        error: { message: 'upstream said something quoting the case' },
        extraction: { candidates: 1, created: 1, updated: 0, skipped: 0 },
        pendingState: { messages: [{ role: 'user', content: 'case facts' }] },
        metadata: { late: 'write' },
      });

      const gen = await db.Generation.findOne({ where: { publicId } });
      expect(gen!.error).toBeNull();
      expect(gen!.extraction).toBeNull();
      expect(gen!.pendingState).toBeNull();
      expect(gen!.metadata).toBeNull();

      // Skeleton fields on the same write still land — suppression is scoped
      // to content, never to status or lifecycle.
      expect(gen!.status).toBe('requires_action');
      expect(gen!.stopReason).toBe('tool-calls');
    });

    test('a content-free lifecycle write is left completely alone', async () => {
      // Several lifecycle writes (the `requires_action` flip in
      // savePendingGeneration among them) are dispatched fire-and-forget, and
      // callers read the row straight after. Suppression must not put a mode
      // lookup in front of a write that carries no content to suppress —
      // doing so widens that race for every generation in the system.
      const publicId = await makeGeneration({
        projectDbId: zeroProjectDbId,
        projectPublicId: zeroProjectId,
        agent: inheritedAgent,
      });

      const before = await db.Generation.findOne({ where: { publicId } });
      const originalStamp = before!.contentRedactedAt;
      expect(originalStamp).not.toBeNull();

      await updateGenerationRecord({
        publicId,
        status: 'requires_action',
        lastActivityAt: new Date(),
      });

      const after = await db.Generation.findOne({ where: { publicId } });
      expect(after!.status).toBe('requires_action');
      // Still redacted, and the stamp did not move — the create-time marker is
      // what makes skipping the lookup here safe.
      expect(after!.contentRedactedAt).toEqual(originalStamp);
      expect(after!.metadata).toBeNull();
    });

    test('a storing agent still persists those same fields', async () => {
      const publicId = await makeGeneration({
        projectDbId: storingProjectDbId,
        projectPublicId: storingProjectId,
        agent: storingAgent,
      });

      await updateGenerationRecord({
        publicId,
        status: 'completed',
        error: { message: 'boom' },
        pendingState: { messages: [] },
      });

      const gen = await db.Generation.findOne({ where: { publicId } });
      expect(gen!.error).toEqual({ message: 'boom' });
      expect(gen!.pendingState).toEqual({ messages: [] });
    });
  });

  describe('recordTraceError', () => {
    test('a storing agent records the error payload', async () => {
      const seeded = await seedTrace({
        projectDbId: storingProjectDbId,
        projectPublicId: storingProjectId,
        agentPublicId: storingAgent.publicId,
      });

      await recordTraceError({
        traceId: seeded.traceId,
        error: { message: 'upstream 500' },
      });

      const row = await db.Trace.findOne({
        where: { publicId: seeded.traceId },
      });
      expect(row!.error).toEqual({ message: 'upstream 500' });
    });

    test('a zero-retention agent records no error payload', async () => {
      // `error` can carry a tool's request/response bodies, which is why a
      // purge clears it — so the never-write path must refuse it too, or the
      // one mode that promises nothing is stored would leak on every failure.
      const seeded = await seedTrace({
        projectDbId: zeroProjectDbId,
        projectPublicId: zeroProjectId,
        agentPublicId: inheritedAgent.publicId,
      });

      await recordTraceError({
        traceId: seeded.traceId,
        error: { message: 'upstream 500', body: 'confidential case text' },
      });

      const row = await db.Trace.findOne({
        where: { publicId: seeded.traceId },
      });
      expect(row!.error).toBeNull();
      expect(row!.contentRedactedAt).not.toBeNull();
    });
  });

  describe('the project floor', () => {
    test('flipping a project to none takes effect on the next write', async () => {
      const flipProject = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'ZR Flip Project' });
      const flipDbId = (await db.Project.findOne({
        where: { publicId: flipProject.body.id },
      }))!.id as number;
      const agent = await makeAgent({
        projectDbId: flipDbId,
        suffix: 'flip',
      });

      const before = await seedTrace({
        projectDbId: flipDbId,
        projectPublicId: flipProject.body.id,
        agentPublicId: agent.publicId,
      });
      expect(before.row.fileId).not.toBeNull();

      await authenticatedTestClient(adminToken)
        .patch(`/api/v1/projects/${flipProject.body.id}`)
        .send({ trace_content_mode: 'none' });

      // No sleep: the update invalidates the mode cache, so the very next
      // write must already see the flip rather than waiting out the TTL.
      const after = await seedTrace({
        projectDbId: flipDbId,
        projectPublicId: flipProject.body.id,
        agentPublicId: agent.publicId,
      });
      expect(after.row.fileId).toBeNull();
    });
  });
});
