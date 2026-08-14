import { db } from 'src/db';
import { emitEvent } from 'src/lib/eventBus';
import { fileException } from 'src/lib/exceptions';
import {
  asCustomEventName,
  type SoatEventName,
  type SoatResourceType,
} from 'src/lib/soatEvents';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

// The Exceptions module (G3 Phase 3). Items have no public create endpoint —
// they are auto-filed by producers (run failures, guardrail tripwires, expired
// approvals) or filed explicitly (`manual`). Lifecycle/dedup/severity are
// exercised via the `fileException` lib (the only way to create one; there is
// no create route); the producer paths are driven end-to-end through the run
// and approval entry points.

describe('Exceptions', () => {
  let adminToken: string;
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
    predicate: (e: {
      kind: string;
      orchestration_run_id: string | null;
    }) => boolean
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
    adminToken = setup.adminToken;
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
      expect(filed.occurrence_count).toBe(1);

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

    // parsePagination's toInt (rest/v1/helpers.ts) falls back to `undefined`
    // (the shared lib default) when a query param doesn't parse to a finite
    // number — every list route shares this helper, but nothing in this
    // codebase sent a malformed limit/offset before.
    test('a non-numeric limit falls back to the default page size', async () => {
      const res = await listExceptions('&limit=not-a-number');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
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

    // Regression: exceptionSrn() built the item SRN from `exception.projectId`,
    // but the mapper's wire field is `project_id` — the SRN resource resolved
    // to `soat:undefined:exception:<id>` and never matched an SRN-scoped
    // policy. An action-only policy (like the rest of this describe block)
    // never exercises the resource-matching path, so it slipped through.
    test('a user with an SRN-scoped (not action-only) policy can get the item', async () => {
      const scopedUserRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/users')
        .send({ username: 'exc-srn-scoped', password: 'excSrnPass123' });
      const scopedPolicyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [
              {
                effect: 'Allow',
                action: ['exceptions:GetException'],
                resource: [`soat:${projectId}:exception:${targetId}`],
              },
            ],
          },
        });
      await authenticatedTestClient(adminToken)
        .put(`/api/v1/users/${scopedUserRes.body.id}/policies`)
        .send({ policy_ids: [scopedPolicyRes.body.id] });
      const scopedToken = await loginAs('exc-srn-scoped', 'excSrnPass123');

      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/exceptions/${targetId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(targetId);
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
      expect(second.occurrence_count).toBe(2);

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
        return (
          e.kind === 'run_failed' && e.orchestration_run_id === runRes.body.id
        );
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
        return (
          e.kind === 'guardrail_tripwire' &&
          e.orchestration_run_id === runRes.body.id
        );
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
        const match = (res.body.data as Record<string, unknown>[]).find(
          predicate
        );
        if (match) return match;
        await new Promise((resolve) => {
          return setTimeout(resolve, 20);
        });
      }
      return null;
    };

    const emit = (
      type: SoatEventName,
      resourceType: SoatResourceType,
      resourceId: string,
      data: Record<string, unknown>
    ) => {
      emitEvent({
        type,
        projectId: projectInternalId,
        projectPublicId: projectId,
        resourceType,
        resourceId,
        data,
        timestamp: new Date().toISOString(),
      });
    };

    test('approvals.expired with full data files an approval_expired exception', async () => {
      emit('approvals.expired', 'approval', 'apr_full_1', {
        approval: {
          id: 'apr_full_1',
          proposed_action: { tool_id: 'tool_x' },
          orchestration_run_id: 'run_exp_1',
          agent_id: 'agent_exp_1',
        },
      });
      const match = await pollException((e) => {
        return (
          e.kind === 'approval_expired' &&
          e.orchestration_run_id === 'run_exp_1'
        );
      });
      expect(match).not.toBeNull();
      expect(match!.severity).toBe('warning');
      expect(match!.agent_id).toBe('agent_exp_1');
    });

    test('approvals.expired with an empty approval falls back to (unknown) with no dedup key', async () => {
      emit('approvals.expired', 'approval', 'apr_empty_1', { approval: {} });
      const match = await pollException((e) => {
        return (
          e.kind === 'approval_expired' &&
          typeof e.title === 'string' &&
          e.title.includes('(unknown)')
        );
      });
      expect(match).not.toBeNull();
      expect(match!.orchestration_run_id).toBeNull();
      expect(match!.agent_id).toBeNull();
    });

    test('orchestration_runs.failed with no error detail files a run_failed exception', async () => {
      emit('orchestration_runs.failed', 'orchestration_run', 'run_noerr_1', {});
      const match = await pollException((e) => {
        return (
          e.kind === 'run_failed' && e.orchestration_run_id === 'run_noerr_1'
        );
      });
      expect(match).not.toBeNull();
      expect(match!.detail).toBeNull();
    });

    test('guardrail.tripwire with a generation (no run) falls back to the resource id for the tool name', async () => {
      emit('guardrail.tripwire', 'guardrail', 'tool_gen_1', {
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
      // No orchestrationRunId on the event → the non-run path; toolName fell back to the
      // event resourceId (there was no toolName in the data).
      expect(match!.orchestration_run_id).toBeNull();
      expect(match!.agent_id).toBe('agent_trip_1');
    });

    test('guardrail.tripwire with no run folds repeated trips of the same agent/tool call site into one item, ignoring the (always-fresh) generation id', async () => {
      emit('guardrail.tripwire', 'guardrail', 'tool_loop_1', {
        generationId: 'gen_loop_1',
        agentId: 'agent_loop_1',
      });
      const first = await pollException((e) => {
        return (
          e.kind === 'guardrail_tripwire' &&
          e.agent_id === 'agent_loop_1' &&
          typeof e.title === 'string' &&
          e.title.includes('tool_loop_1')
        );
      });
      expect(first).not.toBeNull();
      expect(first!.occurrence_count).toBe(1);

      // Same agent/tool call site, but a brand-new generationId (as every real
      // agent generation gets) — must fold into the same open item.
      emit('guardrail.tripwire', 'guardrail', 'tool_loop_1', {
        generationId: 'gen_loop_2',
        agentId: 'agent_loop_1',
      });
      const folded = await pollException((e) => {
        return e.id === first!.id && e.occurrence_count === 2;
      });
      expect(folded).not.toBeNull();

      const res = await listExceptions('');
      const matches = (res.body.data as Record<string, unknown>[]).filter(
        (e) => {
          return (
            e.kind === 'guardrail_tripwire' &&
            e.agent_id === 'agent_loop_1' &&
            typeof e.title === 'string' &&
            e.title.includes('tool_loop_1')
          );
        }
      );
      expect(matches).toHaveLength(1);
    });

    test('an unmatched event type files no exception (handleEvent early return)', async () => {
      emit(
        asCustomEventName({ name: 'noop.unmatched' }),
        'orchestration_run',
        'noop_1',
        { whatever: true }
      );
      // handleEvent runs synchronously on emit; give any (non-existent) filer a
      // tick, then confirm nothing referencing this event was filed.
      await new Promise((resolve) => {
        return setTimeout(resolve, 50);
      });
      const res = await listExceptions('');
      const noop = (res.body.data as Record<string, unknown>[]).find((e) => {
        return typeof e.title === 'string' && e.title.includes('noop');
      });
      expect(noop).toBeUndefined();
    });

    test('a filer rejection is swallowed by handleEvent, not raised as an unhandled rejection', async () => {
      // A nonexistent internal project id makes the filer's insert fail the
      // projects FK deterministically — the only way to drive handleEvent's
      // .catch resilience branch, which was previously covered (or not) by
      // whichever unrelated test happened to produce a filing failure.
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);
      try {
        emitEvent({
          type: 'orchestration_runs.failed',
          projectId: 999999999,
          projectPublicId: 'proj_does_not_exist',
          resourceType: 'orchestration_run',
          resourceId: 'run_fk_reject_1',
          data: {},
          timestamp: new Date().toISOString(),
        });
        // The filer's DB insert rejects asynchronously; give it a bounded
        // moment to settle (same pattern as the unmatched-event test above).
        await new Promise((resolve) => {
          return setTimeout(resolve, 100);
        });
        expect(unhandled).toHaveLength(0);
        const res = await listExceptions('');
        const filed = (res.body.data as Record<string, unknown>[]).find((e) => {
          return (
            typeof e.title === 'string' && e.title.includes('run_fk_reject_1')
          );
        });
        expect(filed).toBeUndefined();
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
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
      expect([a.occurrence_count, b.occurrence_count].sort()).toEqual([1, 2]);
    });
  });
});
