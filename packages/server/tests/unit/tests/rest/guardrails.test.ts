import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

const GUARDRAIL_ACTIONS = [
  'guardrails:CreateGuardrail',
  'guardrails:ListGuardrails',
  'guardrails:GetGuardrail',
  'guardrails:UpdateGuardrail',
  'guardrails:DeleteGuardrail',
  'guardrails:GetGuardrailVersion',
  'guardrails:EvaluateGuardrail',
];

// A class-B-below-500 / C-above document with a 24h-spend guard — the canonical
// example from the guardrails module docs.
const budgetDocument = {
  default_class: 'C',
  class: { if: [{ '<': [{ var: 'args.amount' }, 500] }, 'B', 'C'] },
  guard: { '<': [{ var: 'soat.usage.cost_usd_24h' }, 1000] },
};

describe('Guardrails', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let noPermToken: string;
  let guardrailId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'guardrails',
      policyActions: GUARDRAIL_ACTIONS,
    });

    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;
    noPermToken = setup.noPermToken as string;

    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/guardrails')
      .send({
        project_id: projectId,
        name: 'Shared Guardrail',
        document: budgetDocument,
      });
    guardrailId = res.body.id;
  });

  // A project-scoped API key whose policy excludes `excludedAction`, used to
  // exercise the `projectIds === null` (403) branch on routes that don't take a
  // `project_id` param (unlike `noPermToken`, which resolves to an empty project
  // list and 404s instead).
  const createRestrictedApiKey = async (excludedAction: string) => {
    const allowedActions = GUARDRAIL_ACTIONS.filter((action) => {
      return action !== excludedAction;
    });
    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: { statement: [{ effect: 'Allow', action: allowedActions }] },
      });
    const keyRes = await authenticatedTestClient(userToken)
      .post('/api/v1/api-keys')
      .send({
        name: `No ${excludedAction} Key`,
        project_id: projectId,
        policy_ids: [policyRes.body.id],
      });
    expect(keyRes.status).toBe(201);
    return keyRes.body.key as string;
  };

  describe('POST /api/v1/guardrails', () => {
    test('creates a guardrail and round-trips the document verbatim', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/guardrails')
        .send({
          project_id: projectId,
          name: 'Budget Update Guardrail',
          description: 'Gates budget updates',
          document: budgetDocument,
        });

      expect(response.status).toBe(201);
      expect(response.body.id).toMatch(/^guard_/);
      expect(response.body.project_id).toBe(projectId);
      expect(response.body.name).toBe('Budget Update Guardrail');
      expect(response.body.description).toBe('Gates budget updates');
      expect(response.body.version).toBe(1);
      expect(response.body.context_mode).toBe('merge');
      expect(response.body.context_tool_id).toBeNull();
      // The snake_case document field survives caseTransform unmangled.
      expect(response.body.document.default_class).toBe('C');
      expect(response.body.document.class).toEqual(budgetDocument.class);
      // internal DB id is never exposed
      expect(response.body.internalId).toBeUndefined();
    });

    test('accepts a bare class literal document', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/guardrails')
        .send({
          project_id: projectId,
          name: 'Always Sign-off',
          document: { class: 'C' },
        });
      expect(response.status).toBe(201);
      expect(response.body.document.class).toBe('C');
    });

    test('accepts a document supplied as a JSON-encoded string', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/guardrails')
        .send({
          project_id: projectId,
          name: 'String Document',
          document: JSON.stringify({ class: 'B', escalate: true }),
        });
      expect(response.status).toBe(201);
      expect(response.body.document.escalate).toBe(true);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post('/api/v1/guardrails')
        .send({ project_id: projectId, name: 'X', document: { class: 'C' } });
      expect(response.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .post('/api/v1/guardrails')
        .send({ project_id: projectId, name: 'X', document: { class: 'C' } });
      expect(response.status).toBe(403);
    });

    test('missing name returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/guardrails')
        .send({ project_id: projectId, document: { class: 'C' } });
      expect(response.status).toBe(400);
    });

    test('missing document returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/guardrails')
        .send({ project_id: projectId, name: 'No Doc' });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('document with an unknown field returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/guardrails')
        .send({
          project_id: projectId,
          name: 'Bad',
          document: { class: 'C', rules: [] },
        });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(response.body.error.message).toMatch(/unknown field 'rules'/);
    });

    test('document missing class returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/guardrails')
        .send({
          project_id: projectId,
          name: 'Bad',
          document: { default_class: 'C' },
        });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('document referencing an out-of-catalog soat var returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/guardrails')
        .send({
          project_id: projectId,
          name: 'Bad',
          document: {
            class: 'B',
            guard: { '<': [{ var: 'soat.usage.cost_usd_90d' }, 1] },
          },
        });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(response.body.error.message).toMatch(/soat\.\* catalog/);
    });

    test('malformed document string returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/guardrails')
        .send({
          project_id: projectId,
          name: 'Bad',
          document: '{not valid json',
        });
      expect(response.status).toBe(400);
    });

    test('invalid context_mode returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/guardrails')
        .send({
          project_id: projectId,
          name: 'Bad Mode',
          document: { class: 'C' },
          context_mode: 'sideways',
        });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('admin without project scoping and no project_id returns 400', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/guardrails')
        .send({ name: 'No Project', document: { class: 'C' } });
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('projectId is required');
    });
  });

  describe('GET /api/v1/guardrails', () => {
    test('authenticated user can list guardrails', async () => {
      const response = await authenticatedTestClient(userToken)
        .get('/api/v1/guardrails')
        .query({ project_id: projectId });
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);
      expect(response.body[0].id).toMatch(/^guard_/);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get('/api/v1/guardrails');
      expect(response.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .get('/api/v1/guardrails')
        .query({ project_id: projectId });
      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/guardrails/:guardrail_id', () => {
    test('authenticated user can get a guardrail', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/guardrails/${guardrailId}`
      );
      expect(response.status).toBe(200);
      expect(response.body.id).toBe(guardrailId);
      expect(response.body.document.default_class).toBe('C');
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(
        `/api/v1/guardrails/${guardrailId}`
      );
      expect(response.status).toBe(401);
    });

    // noPermToken has zero policies, so resolveProjectIds returns `[]` (not
    // `null`) — the empty-array project filter matches no guardrail.
    test('user without permission returns 404', async () => {
      const response = await authenticatedTestClient(noPermToken).get(
        `/api/v1/guardrails/${guardrailId}`
      );
      expect(response.status).toBe(404);
    });

    test('non-existent guardrail returns 404', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/guardrails/guard_nonexistent00000'
      );
      expect(response.status).toBe(404);
    });

    test('project-scoped API key without GetGuardrail returns 403', async () => {
      const rawKey = await createRestrictedApiKey('guardrails:GetGuardrail');
      const response = await authenticatedTestClient(rawKey).get(
        `/api/v1/guardrails/${guardrailId}`
      );
      expect(response.status).toBe(403);
    });
  });

  describe('PATCH /api/v1/guardrails/:guardrail_id', () => {
    let patchId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/guardrails')
        .send({
          project_id: projectId,
          name: 'Patch Target',
          document: { class: 'C' },
        });
      patchId = res.body.id;
    });

    test('metadata-only edit does not bump the version', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/guardrails/${patchId}`)
        .send({ name: 'Renamed', description: 'now described' });
      expect(response.status).toBe(200);
      expect(response.body.name).toBe('Renamed');
      expect(response.body.description).toBe('now described');
      expect(response.body.version).toBe(1);
    });

    test('a document write bumps and archives the version', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/guardrails/${patchId}`)
        .send({ document: { class: 'B', escalate: true } });
      expect(response.status).toBe(200);
      expect(response.body.version).toBe(2);
      expect(response.body.document.escalate).toBe(true);
    });

    test('invalid document returns 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/guardrails/${patchId}`)
        .send({ document: { class: 'nope' } });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .patch(`/api/v1/guardrails/${patchId}`)
        .send({ name: 'X' });
      expect(response.status).toBe(401);
    });

    test('project-scoped API key without UpdateGuardrail returns 403', async () => {
      const rawKey = await createRestrictedApiKey('guardrails:UpdateGuardrail');
      const response = await authenticatedTestClient(rawKey)
        .patch(`/api/v1/guardrails/${patchId}`)
        .send({ name: 'Nope' });
      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/guardrails/:guardrail_id/versions/:version', () => {
    let versionedId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/guardrails')
        .send({
          project_id: projectId,
          name: 'Versioned',
          document: { class: 'C' },
        });
      versionedId = res.body.id;
      await authenticatedTestClient(userToken)
        .patch(`/api/v1/guardrails/${versionedId}`)
        .send({ document: { class: 'B' } });
    });

    test('fetches the original archived version', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/guardrails/${versionedId}/versions/1`
      );
      expect(response.status).toBe(200);
      expect(response.body.guardrail_id).toBe(versionedId);
      expect(response.body.version).toBe(1);
      expect(response.body.document.class).toBe('C');
    });

    test('fetches a later archived version', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/guardrails/${versionedId}/versions/2`
      );
      expect(response.status).toBe(200);
      expect(response.body.document.class).toBe('B');
    });

    test('unknown version returns 404', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/guardrails/${versionedId}/versions/999`
      );
      expect(response.status).toBe(404);
    });

    test('non-integer version returns 400', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/guardrails/${versionedId}/versions/abc`
      );
      expect(response.status).toBe(400);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.get(
        `/api/v1/guardrails/${versionedId}/versions/1`
      );
      expect(response.status).toBe(401);
    });
  });

  describe('DELETE /api/v1/guardrails/:guardrail_id', () => {
    test('deletes a guardrail and its versions', async () => {
      const createRes = await authenticatedTestClient(userToken)
        .post('/api/v1/guardrails')
        .send({
          project_id: projectId,
          name: 'Throwaway',
          document: { class: 'C' },
        });
      const id = createRes.body.id;

      const delRes = await authenticatedTestClient(userToken).delete(
        `/api/v1/guardrails/${id}`
      );
      expect(delRes.status).toBe(204);

      const getRes = await authenticatedTestClient(userToken).get(
        `/api/v1/guardrails/${id}`
      );
      expect(getRes.status).toBe(404);

      const versionRes = await authenticatedTestClient(userToken).get(
        `/api/v1/guardrails/${id}/versions/1`
      );
      expect(versionRes.status).toBe(404);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient.delete(
        `/api/v1/guardrails/${guardrailId}`
      );
      expect(response.status).toBe(401);
    });

    test('non-existent guardrail returns 404', async () => {
      const response = await authenticatedTestClient(userToken).delete(
        '/api/v1/guardrails/guard_nonexistent00000'
      );
      expect(response.status).toBe(404);
    });

    test('project-scoped API key without DeleteGuardrail returns 403', async () => {
      const rawKey = await createRestrictedApiKey('guardrails:DeleteGuardrail');
      const response = await authenticatedTestClient(rawKey).delete(
        `/api/v1/guardrails/${guardrailId}`
      );
      expect(response.status).toBe(403);
    });
  });

  describe('POST /api/v1/guardrails/{guardrail_id}/evaluate', () => {
    let evalGuardrailId: string;

    beforeAll(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/guardrails')
        .send({
          project_id: projectId,
          name: 'Dry-run Guardrail',
          document: {
            default_class: 'C',
            class: { if: [{ '<': [{ var: 'args.amount' }, 500] }, 'B', 'C'] },
            guard: { '==': [{ var: 'context.tier' }, 'trusted'] },
          },
        });
      evalGuardrailId = res.body.id;
    });

    test('returns the would-be record and executes nothing (class B, guard passes)', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/guardrails/${evalGuardrailId}/evaluate`)
        .send({
          args: { amount: 100 },
          guardrail_context: { tier: 'trusted' },
        });

      expect(response.status).toBe(200);
      expect(response.body.kind).toBe('guardrail_evaluation');
      expect(response.body.guardrail_id).toBe(evalGuardrailId);
      expect(response.body.class).toBe('B');
      expect(response.body.decision).toBe('execute');
      expect(response.body.guard_result).toBe(true);
      expect(response.body.context_source).toBe('caller');
      // Only the referenced vars are snapshotted, at their evaluation-time values.
      expect(response.body.context_snapshot['args.amount']).toBe(100);
      expect(response.body.context_snapshot['context.tier']).toBe('trusted');
    });

    test('resolves class C above the threshold → route_to_approval', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/guardrails/${evalGuardrailId}/evaluate`)
        .send({ args: { amount: 999 } });

      expect(response.status).toBe(200);
      expect(response.body.class).toBe('C');
      expect(response.body.decision).toBe('route_to_approval');
    });

    test('a failing class-B guard trips (tripwire) in the dry run', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/guardrails/${evalGuardrailId}/evaluate`)
        .send({
          args: { amount: 100 },
          guardrail_context: { tier: 'unknown' },
        });

      expect(response.status).toBe(200);
      expect(response.body.class).toBe('B');
      expect(response.body.guard_result).toBe(false);
      expect(response.body.decision).toBe('tripwire');
    });

    test('files no approval item and writes no audit row', async () => {
      const before = await authenticatedTestClient(userToken).get(
        '/api/v1/approvals?status=pending'
      );
      await authenticatedTestClient(userToken)
        .post(`/api/v1/guardrails/${evalGuardrailId}/evaluate`)
        .send({ args: { amount: 999 } });
      const after = await authenticatedTestClient(userToken).get(
        '/api/v1/approvals?status=pending'
      );
      expect(after.body.length).toBe(before.body.length);
    });

    test('resolves live soat.usage.* and accepts an optional tool_id', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/guardrails')
        .send({
          project_id: projectId,
          name: 'Usage Guardrail',
          document: {
            class: 'B',
            guard: { '<': [{ var: 'soat.usage.cost_usd_24h' }, 1000] },
          },
        });
      const usageGuardrailId = res.body.id;

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/guardrails/${usageGuardrailId}/evaluate`)
        // A tool_id that need not exist — it only resolves soat.tool.*.
        .send({ args: { amount: 1 }, tool_id: 'tool_unknown00000000' });

      expect(response.status).toBe(200);
      expect(response.body.class).toBe('B');
      // No usage events → windowed cost is 0, under the ceiling → guard passes.
      expect(response.body.guard_result).toBe(true);
      expect(response.body.decision).toBe('execute');
      expect(response.body.context_snapshot['soat.usage.cost_usd_24h']).toBe(0);
    });

    test('unauthenticated request returns 401', async () => {
      const response = await testClient
        .post(`/api/v1/guardrails/${evalGuardrailId}/evaluate`)
        .send({ args: {} });
      expect(response.status).toBe(401);
    });

    test('non-existent guardrail returns 404', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/guardrails/guard_nonexistent00000/evaluate')
        .send({ args: {} });
      expect(response.status).toBe(404);
    });

    test('project-scoped API key without EvaluateGuardrail returns 403', async () => {
      const rawKey = await createRestrictedApiKey(
        'guardrails:EvaluateGuardrail'
      );
      const response = await authenticatedTestClient(rawKey)
        .post(`/api/v1/guardrails/${evalGuardrailId}/evaluate`)
        .send({ args: {} });
      expect(response.status).toBe(403);
    });
  });
});
