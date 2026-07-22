import { db } from 'src/db';
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
      const match = res.body.find(predicate);
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
        list.body.some((e: { id: string }) => {
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
        (await testClient.post(`/api/v1/exceptions/${targetId}/resolve`).send({}))
          .status
      ).toBe(401);
    });

    test('requests without permission are 403', async () => {
      const client = authenticatedTestClient(noPermToken);
      expect(
        (await client.get(`/api/v1/exceptions/${targetId}`)).status
      ).toBe(403);
      expect(
        (await client.post(`/api/v1/exceptions/${targetId}/acknowledge`).send({}))
          .status
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
      const matches = list.body.filter((e: { id: string }) => {
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
});
