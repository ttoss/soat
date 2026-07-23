import { db } from 'src/db';
import { emitEvent } from 'src/lib/eventBus';
import { fileException } from 'src/lib/exceptions';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

// The Exceptions module (G3 Phase 3). Items have no public create endpoint —
// they are auto-filed by producers (run failures, guardrail tripwires, expired
// approvals) or filed explicitly (`manual`). Lifecycle/dedup/severity are
// exercised via the `fileException` lib (the only way to create one; there is
// no create route); the producer paths are driven end-to-end through the run
// and approval entry points.

describe('Exceptions', () => {
  let userToken: string;
  let noPermToken: string;
  let projectId: string;
  let projectInternalId: number;

  const listExceptions = async (query: string) => {
    return authenticatedTestClient(userToken).get(
      `/api/v1/exceptions?project_id=${projectId}${query}`
    );
  };

  // Producers file exceptions fire-and-forget off an event, so poll the
  // observable side effect rather than racing it.
  const waitForException = async (
    predicate: (e: { kind: string; run_id: string | null }) => boolean
  ) => {
    for (let i = 0; i < 100; i += 1) {
      const res = await listExceptions('');
      const match = res.body.data.find(predicate);
      if (match) return match;
      await new Promise((resolve) => {
        return setTimeout(resolve, 20);
      });
    }
    return null;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'exc',
      policyActions: [
        'exceptions:ListExceptions',
        'exceptions:GetException',
        'exceptions:AcknowledgeException',
        'exceptions:ResolveException',
        'orchestrations:CreateOrchestration',
        'orchestrations:StartRun',
        'orchestrations:GetRun',
        'guardrails:CreateGuardrail',
        'tools:CreateTool',
      ],
    });
    userToken = setup.userToken;
    noPermToken = setup.noPermToken!;
    projectId = setup.projectId;
    const project = await db.Project.findOne({
      where: { publicId: projectId },
    });
    projectInternalId = project!.id as number;
  });

  describe('lifecycle', () => {
    test('file → list → get → acknowledge → resolve → already-resolved', async () => {
      const filed = await fileException({
        projectId: projectInternalId,
        kind: 'manual',
        title: 'Manual exception',
        detail: { foo: 'bar' },
      });
      expect(filed.id).toMatch(/^exc_/);
      expect(filed.status).toBe('open');
      expect(filed.severity).toBe('warning'); // manual default
      expect(filed.occurrenceCount).toBe(1);

      const list = await listExceptions('');
      expect(list.status).toBe(200);
      expect(
        list.body.data.some((e: { id: string }) => {
          return e.id === filed.id;
        })
      ).toBe(true);

      const get = await authenticatedTestClient(userToken).get(
        `/api/v1/exceptions/${filed.id}`
      );
      expect(get.status).toBe(200);
      expect(get.body.id).toBe(filed.id);
      expect(get.body.project_id).toBe(projectId);
      expect(get.body.kind).toBe('manual');
      // internal ids never leak
      expect(get.body.resolved_by_user_id).toBeUndefined();

      const ack = await authenticatedTestClient(userToken)
        .post(`/api/v1/exceptions/${filed.id}/acknowledge`)
        .send({});
      expect(ack.status).toBe(200);
      expect(ack.body.status).toBe('acknowledged');
      expect(ack.body.acknowledged_by).toBeDefined();

      const resolve = await authenticatedTestClient(userToken)
        .post(`/api/v1/exceptions/${filed.id}/resolve`)
        .send({ note: 'Fixed the root cause.' });
      expect(resolve.status).toBe(200);
      expect(resolve.body.status).toBe('resolved');
      expect(resolve.body.resolution_note).toBe('Fixed the root cause.');
      expect(resolve.body.resolved_by).toBeDefined();

      const again = await authenticatedTestClient(userToken)
        .post(`/api/v1/exceptions/${filed.id}/resolve`)
        .send({});
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('EXCEPTION_ALREADY_RESOLVED');
    });

    test('unauthenticated list is 401', async () => {
      const res = await testClient.get('/api/v1/exceptions');
      expect(res.status).toBe(401);
    });

    test('list without permission is 403', async () => {
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/exceptions?project_id=${projectId}`
      );
      expect(res.status).toBe(403);
    });

    test('get a non-existent exception is 404', async () => {
      const res = await authenticatedTestClient(userToken).get(
        '/api/v1/exceptions/exc_doesnotexist000'
      );
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('EXCEPTION_NOT_FOUND');
    });
  });

  describe('authorization on get / acknowledge / resolve', () => {
    let targetId: string;

    beforeAll(async () => {
      const filed = await fileException({
        projectId: projectInternalId,
        kind: 'manual',
        title: 'Auth target',
      });
      targetId = filed.id;
    });

    test('unauthenticated requests are 401', async () => {
      expect(
        (await testClient.get(`/api/v1/exceptions/${targetId}`)).status
      ).toBe(401);
      expect(
        (
          await testClient
            .post(`/api/v1/exceptions/${targetId}/acknowledge`)
            .send({})
        ).status
      ).toBe(401);
      expect(
        (
          await testClient
            .post(`/api/v1/exceptions/${targetId}/resolve`)
            .send({})
        ).status
      ).toBe(401);
    });

    test('requests without permission are 403', async () => {
      const client = authenticatedTestClient(noPermToken);
      expect((await client.get(`/api/v1/exceptions/${targetId}`)).status).toBe(
        403
      );
      expect(
        (
          await client
            .post(`/api/v1/exceptions/${targetId}/acknowledge`)
            .send({})
        ).status
      ).toBe(403);
      expect(
        (await client.post(`/api/v1/exceptions/${targetId}/resolve`).send({}))
          .status
      ).toBe(403);
    });
  });

  describe('dedup and severity', () => {
    test('repeated file with the same dedup_key folds into one item, incrementing occurrence_count', async () => {
      const dedupKey = 'excdedup:tripwire:1';
      const first = await fileException({
        projectId: projectInternalId,
        kind: 'guardrail_tripwire',
        title: 'Tripwire',
        dedupKey,
      });
      const second = await fileException({
        projectId: projectInternalId,
        kind: 'guardrail_tripwire',
        title: 'Tripwire',
        dedupKey,
      });
      expect(second.id).toBe(first.id);
      expect(second.occurrenceCount).toBe(2);

      const list = await listExceptions('&kind=guardrail_tripwire');
      const matches = list.body.data.filter((e: { id: string }) => {
        return e.id === first.id;
      });
      expect(matches).toHaveLength(1);
      expect(matches[0].occurrence_count).toBe(2);
    });

    test('kind sets the default severity, and an explicit severity overrides it', async () => {
      const def = await fileException({
        projectId: projectInternalId,
        kind: 'run_failed',
        title: 'Run failed',
      });
      expect(def.severity).toBe('critical');

      const overridden = await fileException({
        projectId: projectInternalId,
        kind: 'run_failed',
        title: 'Run failed, but quiet',
        severity: 'info',
      });
      expect(overridden.severity).toBe('info');
    });
  });

  describe('producers', () => {
    test('a failed orchestration run files a run_failed exception', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Exception Failing Run',
          project_id: projectId,
          nodes: [
            {
              id: 'boom',
              type: 'tool',
              tool_id: 'tool_doesnotexist',
              input_mapping: {},
            },
          ],
          edges: [],
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ wait: true, orchestration_id: createRes.body.id, input: {} });
      expect(runRes.body.status).toBe('failed');

      const match = await waitForException((e) => {
        return e.kind === 'run_failed' && e.run_id === runRes.body.id;
      });
      expect(match).not.toBeNull();
      expect(match.severity).toBe('critical');
    });

    test('a guardrail tripwire on a tool node files a guardrail_tripwire exception', async () => {
      // class B with a guard that always fails, no escalate → tripwire.
      const guardrailRes = await authenticatedTestClient(userToken)
        .post('/api/v1/guardrails')
        .send({
          project_id: projectId,
          name: 'Always Trips',
          document: { class: 'B', guard: { '==': [1, 2] } },
        });
      expect(guardrailRes.status).toBe(201);

      const toolRes = await authenticatedTestClient(userToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'Tripwire Tool',
          type: 'client',
          guardrail_ids: [guardrailRes.body.id],
        });
      expect(toolRes.status).toBe(201);

      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          name: 'Exception Tripwire Run',
          project_id: projectId,
          nodes: [
            {
              id: 'act',
              type: 'tool',
              tool_id: toolRes.body.id,
              input_mapping: {},
            },
          ],
          edges: [],
        });
      expect(createRes.status).toBe(201);

      const runRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestration-runs')
        .send({ wait: true, orchestration_id: createRes.body.id, input: {} });
      expect(runRes.status).toBe(201);

      const match = await waitForException((e) => {
        return e.kind === 'guardrail_tripwire' && e.run_id === runRes.body.id;
      });
      expect(match).not.toBeNull();
    });
  });

  // The producers are fire-and-forget off the event bus, so their branches were
  // only ever covered incidentally by other tests' async handlers landing in
  // time — which made src/lib/exceptions.ts coverage flaky and intermittently
  // failed the CI coverage gate. Drive each producer (and the dedup-race path)
  // deterministically here: emit the event directly and poll the filed row, so
  // every branch is exercised regardless of async timing. No production change.
  describe('producer branch coverage (deterministic)', () => {
    const pollException = async (
      predicate: (e: Record<string, unknown>) => boolean
    ): Promise<Record<string, unknown> | null> => {
      for (let i = 0; i < 100; i += 1) {
        const res = await listExceptions('');
        const match = (res.body as Record<string, unknown>[]).find(predicate);
        if (match) return match;
        await new Promise((resolve) => {
          return setTimeout(resolve, 20);
        });
      }
      return null;
    };

    const emit = (
      type: string,
      resourceId: string,
      data: Record<string, unknown>
    ) => {
      emitEvent({
        type,
        projectId: projectInternalId,
        projectPublicId: projectId,
        resourceType: 'test',
        resourceId,
        data,
        timestamp: new Date().toISOString(),
      });
    };

    test('approvals.expired with full data files an approval_expired exception', async () => {
      emit('approvals.expired', 'apr_full_1', {
        approval: {
          id: 'apr_full_1',
          proposedAction: { toolId: 'tool_x' },
          runId: 'run_exp_1',
          agentId: 'agent_exp_1',
        },
      });
      const match = await pollException((e) => {
        return e.kind === 'approval_expired' && e.run_id === 'run_exp_1';
      });
      expect(match).not.toBeNull();
      expect(match!.severity).toBe('warning');
      expect(match!.agent_id).toBe('agent_exp_1');
    });

    test('approvals.expired with an empty approval falls back to (unknown) with no dedup key', async () => {
      emit('approvals.expired', 'apr_empty_1', { approval: {} });
      const match = await pollException((e) => {
        return (
          e.kind === 'approval_expired' &&
          typeof e.title === 'string' &&
          e.title.includes('(unknown)')
        );
      });
      expect(match).not.toBeNull();
      expect(match!.run_id).toBeNull();
      expect(match!.agent_id).toBeNull();
    });

    test('orchestration_runs.failed with no error detail files a run_failed exception', async () => {
      emit('orchestration_runs.failed', 'run_noerr_1', {});
      const match = await pollException((e) => {
        return e.kind === 'run_failed' && e.run_id === 'run_noerr_1';
      });
      expect(match).not.toBeNull();
      expect(match!.detail).toBeNull();
    });

    test('guardrail.tripwire with a generation (no run) scopes by generation id and falls back to the resource id for the tool name', async () => {
      emit('guardrail.tripwire', 'tool_gen_1', {
        generationId: 'gen_trip_1',
        agentId: 'agent_trip_1',
      });
      const match = await pollException((e) => {
        return (
          e.kind === 'guardrail_tripwire' &&
          typeof e.title === 'string' &&
          e.title.includes('tool_gen_1')
        );
      });
      expect(match).not.toBeNull();
      // No runId on the event → the generation path; toolName fell back to the
      // event resourceId (there was no toolName in the data).
      expect(match!.run_id).toBeNull();
      expect(match!.agent_id).toBe('agent_trip_1');
    });

    test('an unmatched event type files no exception (handleEvent early return)', async () => {
      emit('noop.unmatched', 'noop_1', { whatever: true });
      // handleEvent runs synchronously on emit; give any (non-existent) filer a
      // tick, then confirm nothing referencing this event was filed.
      await new Promise((resolve) => {
        return setTimeout(resolve, 50);
      });
      const res = await listExceptions('');
      const noop = (res.body as Record<string, unknown>[]).find((e) => {
        return typeof e.title === 'string' && e.title.includes('noop');
      });
      expect(noop).toBeUndefined();
    });

    test('concurrent files with the same fresh dedup key fold via the unique-violation path', async () => {
      const dedupKey = 'excrace:concurrent:1';
      const [a, b] = await Promise.all([
        fileException({
          projectId: projectInternalId,
          kind: 'manual',
          title: 'Race',
          dedupKey,
        }),
        fileException({
          projectId: projectInternalId,
          kind: 'manual',
          title: 'Race',
          dedupKey,
        }),
      ]);
      // The partial unique index on (dedup_key WHERE status = 'open') guarantees
      // one insert wins and the other folds into it — same item, occurrence 2.
      expect(a.id).toBe(b.id);
      expect([a.occurrenceCount, b.occurrenceCount].sort()).toEqual([1, 2]);
    });
  });
});
