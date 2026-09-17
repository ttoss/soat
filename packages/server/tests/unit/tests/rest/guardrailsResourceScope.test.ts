import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, loginAs } from '../../testClient';

/**
 * Guardrails authorize per guardrail, not per project — on the guardrail's own
 * routes, on its dry-run evaluation, and on its version history.
 */
describe('a policy scoped to one guardrail does not reach another', () => {
  let adminToken: string;
  let projectId: string;
  let scopedToken: string;
  let allowedId: string;
  let otherId: string;

  const GUARDRAIL_ACTIONS = [
    'guardrails:GetGuardrail',
    'guardrails:UpdateGuardrail',
    'guardrails:DeleteGuardrail',
    'guardrails:EvaluateGuardrail',
    'guardrails:ListGuardrailVersions',
    'guardrails:GetGuardrailVersion',
    'guardrails:RestoreGuardrailVersion',
    'guardrails:ListGuardrails',
  ];

  const createGuardrail = async (name: string): Promise<string> => {
    const response = await authenticatedTestClient(adminToken)
      .post('/api/v1/guardrails')
      .send({
        project_id: projectId,
        name,
        document: {
          default_class: 'C',
          class: { if: [{ '<': [{ var: 'args.amount' }, 500] }, 'B', 'C'] },
          guard: { '<': [{ var: 'args.amount' }, 1000] },
        },
      });
    expect(response.status).toBe(201);
    return response.body.id;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'guardscope',
      policyActions: GUARDRAIL_ACTIONS,
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;

    allowedId = await createGuardrail('Scoped Guardrail');
    otherId = await createGuardrail('Other Guardrail');

    const scopedUser = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'guardscopescoped', password: 'guardScopePass1' });
    const scopedPolicy = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: GUARDRAIL_ACTIONS,
              resource: [`srn:${projectId}:guardrail:${allowedId}`],
            },
          ],
        },
      });
    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${scopedUser.body.id}/policies`)
      .send({ policy_ids: [scopedPolicy.body.id] });
    scopedToken = await loginAs('guardscopescoped', 'guardScopePass1');
  });

  describe('GET /api/v1/guardrails/:guardrail_id', () => {
    test('reaches the guardrail the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/guardrails/${allowedId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(allowedId);
    });

    test('hides a sibling guardrail in the same project', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/guardrails/${otherId}`
      );

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });
  });

  describe('PATCH /api/v1/guardrails/:guardrail_id', () => {
    test('refuses a sibling guardrail', async () => {
      const response = await authenticatedTestClient(scopedToken)
        .patch(`/api/v1/guardrails/${otherId}`)
        .send({ description: 'Rewritten by a caller I may not touch.' });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    test('reaches the guardrail the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken)
        .patch(`/api/v1/guardrails/${allowedId}`)
        .send({ description: 'Scoped rewrite.' });

      expect(response.status).toBe(200);
      expect(response.body.description).toBe('Scoped rewrite.');
    });
  });

  describe('POST /api/v1/guardrails/:guardrail_id/evaluate', () => {
    test('refuses a sibling guardrail', async () => {
      const response = await authenticatedTestClient(scopedToken)
        .post(`/api/v1/guardrails/${otherId}/evaluate`)
        .send({ args: { amount: 100 } });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    test('reaches the guardrail the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken)
        .post(`/api/v1/guardrails/${allowedId}/evaluate`)
        .send({ args: { amount: 100 } });

      expect(response.status).toBe(200);
      expect(response.body.guardrail_id).toBe(allowedId);
    });
  });

  describe('GET /api/v1/guardrails/:guardrail_id/versions', () => {
    test('reaches the guardrail the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/guardrails/${allowedId}/versions`
      );

      expect(response.status).toBe(200);
    });

    test('hides a sibling guardrail', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/guardrails/${otherId}/versions`
      );

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/v1/guardrails/:guardrail_id/versions/:version', () => {
    test('reaches the guardrail the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/guardrails/${allowedId}/versions/1`
      );

      expect(response.status).toBe(200);
    });

    test('hides a sibling guardrail', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/guardrails/${otherId}/versions/1`
      );

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/v1/guardrails/:guardrail_id/versions/:version/restore', () => {
    test('refuses a sibling guardrail', async () => {
      const response = await authenticatedTestClient(scopedToken).post(
        `/api/v1/guardrails/${otherId}/versions/1/restore`
      );

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    test('reaches the guardrail the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken).post(
        `/api/v1/guardrails/${allowedId}/versions/1/restore`
      );

      expect(response.status).toBe(200);
    });
  });

  describe('DELETE /api/v1/guardrails/:guardrail_id', () => {
    test('refuses a sibling guardrail', async () => {
      const response = await authenticatedTestClient(scopedToken).delete(
        `/api/v1/guardrails/${otherId}`
      );

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    test('reaches the guardrail the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken).delete(
        `/api/v1/guardrails/${allowedId}`
      );

      expect(response.status).toBe(204);
    });
  });
});
