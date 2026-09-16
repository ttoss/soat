import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, loginAs } from '../../testClient';

/**
 * Datasets and evals authorize per resource, not per project.
 *
 * Their nested routes authorize through the parent named in the path — a
 * dataset **item** through its dataset, an eval **run** through its eval — the
 * way a memory authorizes through its store. Neither carries a project of its
 * own, so the parent is both the only resource that can answer "which project"
 * and the one a policy author names (#1339).
 *
 * Which refusal a route answers follows what its action does, not which helper
 * it used to reach for: a read hides the resource (`404`), a write refuses it
 * (`403`). This module reached for the write helper on its reads too, and
 * keeping that literally would have turned a cross-project read from `404` into
 * `403` — announcing across a tenant boundary that a dataset exists.
 */
describe('a policy scoped to one dataset or eval does not reach another', () => {
  let adminToken: string;
  let projectId: string;
  let scopedToken: string;
  let allowedDatasetId: string;
  let otherDatasetId: string;
  let allowedItemId: string;
  let otherItemId: string;
  let allowedEvalId: string;
  let otherEvalId: string;

  const EVALUATION_ACTIONS = [
    'evaluations:GetDataset',
    'evaluations:CreateDataset',
    'evaluations:DeleteDataset',
    'evaluations:ListDatasets',
    'evaluations:GetEval',
    'evaluations:CreateEval',
    'evaluations:DeleteEval',
    'evaluations:RunEval',
    'evaluations:ListEvals',
    'generations:GetGeneration',
  ];

  const createDataset = async (name: string): Promise<string> => {
    const response = await authenticatedTestClient(adminToken)
      .post('/api/v1/datasets')
      .send({ project_id: projectId, name });
    expect(response.status).toBe(201);
    return response.body.id;
  };

  const addItem = async (datasetId: string): Promise<string> => {
    const response = await authenticatedTestClient(adminToken)
      .post(`/api/v1/datasets/${datasetId}/items`)
      .send({
        input: [{ role: 'user', content: 'Where is my invoice?' }],
        expected_output: 'invoice',
      });
    expect(response.status).toBe(201);
    return response.body.id;
  };

  const createEval = async (args: {
    name: string;
    agentId: string;
    datasetId: string;
  }): Promise<string> => {
    const response = await authenticatedTestClient(adminToken)
      .post('/api/v1/evals')
      .send({
        project_id: projectId,
        name: args.name,
        agent_id: args.agentId,
        dataset_id: args.datasetId,
        scorers: [{ type: 'contains', value: 'invoice' }],
      });
    expect(response.status).toBe(201);
    return response.body.id;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'evalscope',
      policyActions: EVALUATION_ACTIONS,
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;

    const provider = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Scope Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    const agent = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        name: 'Scope Agent',
        ai_provider_id: provider.body.id,
      });

    allowedDatasetId = await createDataset('Scoped Dataset');
    otherDatasetId = await createDataset('Other Dataset');
    allowedItemId = await addItem(allowedDatasetId);
    otherItemId = await addItem(otherDatasetId);

    allowedEvalId = await createEval({
      name: 'scoped-eval',
      agentId: agent.body.id,
      datasetId: allowedDatasetId,
    });
    otherEvalId = await createEval({
      name: 'other-eval',
      agentId: agent.body.id,
      datasetId: otherDatasetId,
    });

    const scopedUser = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'evalscopescoped', password: 'evalScopePass1' });
    const scopedPolicy = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: EVALUATION_ACTIONS,
              resource: [
                `srn:${projectId}:dataset:${allowedDatasetId}`,
                `srn:${projectId}:eval:${allowedEvalId}`,
                `srn:${projectId}:generation:*`,
              ],
            },
          ],
        },
      });
    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${scopedUser.body.id}/policies`)
      .send({ policy_ids: [scopedPolicy.body.id] });
    scopedToken = await loginAs('evalscopescoped', 'evalScopePass1');
  });

  describe('GET /api/v1/datasets/:dataset_id', () => {
    test('reaches the dataset the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/datasets/${allowedDatasetId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(allowedDatasetId);
    });

    test('hides a sibling dataset in the same project', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/datasets/${otherDatasetId}`
      );

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });
  });

  describe('PUT /api/v1/datasets/:dataset_id', () => {
    test('refuses a sibling dataset', async () => {
      const response = await authenticatedTestClient(scopedToken)
        .put(`/api/v1/datasets/${otherDatasetId}`)
        .send({ description: 'Rewritten by a caller I may not touch.' });

      expect(response.status).toBe(403);
    });

    test('reaches the dataset the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken)
        .put(`/api/v1/datasets/${allowedDatasetId}`)
        .send({ description: 'Scoped rewrite.' });

      expect(response.status).toBe(200);
      expect(response.body.description).toBe('Scoped rewrite.');
    });
  });

  describe('GET /api/v1/datasets/:dataset_id/items', () => {
    test('reaches the dataset the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/datasets/${allowedDatasetId}/items`
      );

      expect(response.status).toBe(200);
    });

    test('hides a sibling dataset', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/datasets/${otherDatasetId}/items`
      );

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/v1/datasets/:dataset_id/items', () => {
    test('refuses a sibling dataset', async () => {
      const response = await authenticatedTestClient(scopedToken)
        .post(`/api/v1/datasets/${otherDatasetId}/items`)
        .send({
          input: [{ role: 'user', content: 'Smuggled in.' }],
          expected_output: 'nope',
        });

      expect(response.status).toBe(403);
    });

    test('reaches the dataset the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken)
        .post(`/api/v1/datasets/${allowedDatasetId}/items`)
        .send({
          input: [{ role: 'user', content: 'Where is my receipt?' }],
          expected_output: 'receipt',
        });

      expect(response.status).toBe(201);
    });
  });

  describe('POST /api/v1/datasets/:dataset_id/items/from-generation', () => {
    // The dataset is refused before the generation is even looked at, which is
    // the point: curating reads a turn, so both halves are checked.
    test('refuses a sibling dataset', async () => {
      const response = await authenticatedTestClient(scopedToken)
        .post(`/api/v1/datasets/${otherDatasetId}/items/from-generation`)
        .send({ generation_id: 'gen_doesnotexist00000' });

      expect(response.status).toBe(403);
    });
  });

  describe('PUT /api/v1/datasets/:dataset_id/items/:item_id', () => {
    test('refuses an item of a sibling dataset', async () => {
      const response = await authenticatedTestClient(scopedToken)
        .put(`/api/v1/datasets/${otherDatasetId}/items/${otherItemId}`)
        .send({
          input: [{ role: 'user', content: 'Rewritten.' }],
          expected_output: 'nope',
        });

      expect(response.status).toBe(403);
    });

    test('reaches an item of the dataset the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken)
        .put(`/api/v1/datasets/${allowedDatasetId}/items/${allowedItemId}`)
        .send({
          input: [{ role: 'user', content: 'Rewritten.' }],
          expected_output: 'invoice',
        });

      expect(response.status).toBe(200);
    });
  });

  describe('DELETE /api/v1/datasets/:dataset_id/items/:item_id', () => {
    test('refuses an item of a sibling dataset', async () => {
      const response = await authenticatedTestClient(scopedToken).delete(
        `/api/v1/datasets/${otherDatasetId}/items/${otherItemId}`
      );

      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/evals/:eval_id', () => {
    test('reaches the eval the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/evals/${allowedEvalId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(allowedEvalId);
    });

    test('hides a sibling eval in the same project', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/evals/${otherEvalId}`
      );

      expect(response.status).toBe(404);
    });
  });

  describe('PUT /api/v1/evals/:eval_id', () => {
    test('refuses a sibling eval', async () => {
      const response = await authenticatedTestClient(scopedToken)
        .put(`/api/v1/evals/${otherEvalId}`)
        .send({ pass_threshold: 0.1 });

      expect(response.status).toBe(403);
    });

    test('reaches the eval the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken)
        .put(`/api/v1/evals/${allowedEvalId}`)
        .send({ pass_threshold: 0.25 });

      expect(response.status).toBe(200);
      expect(response.body.pass_threshold).toBe(0.25);
    });
  });

  describe('GET /api/v1/evals/:eval_id/runs', () => {
    test('reaches the eval the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/evals/${allowedEvalId}/runs`
      );

      expect(response.status).toBe(200);
    });

    test('hides a sibling eval', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/evals/${otherEvalId}/runs`
      );

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/v1/evals/:eval_id/runs', () => {
    test('refuses a sibling eval', async () => {
      const response = await authenticatedTestClient(scopedToken)
        .post(`/api/v1/evals/${otherEvalId}/runs`)
        .send({});

      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/evals/:eval_id/runs/:eval_run_id', () => {
    test('hides a run under a sibling eval', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/evals/${otherEvalId}/runs/evalrun_doesnotexist`
      );

      expect(response.status).toBe(404);
    });

    // 404 is the run lookup answering under an eval the caller *may* reach:
    // the refusal is gone and the missing run is all that is left.
    test('reaches the eval the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/evals/${allowedEvalId}/runs/evalrun_doesnotexist`
      );

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/v1/evals/:eval_id/runs/:eval_run_id/results', () => {
    test('hides a run under a sibling eval', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/evals/${otherEvalId}/runs/evalrun_doesnotexist/results`
      );

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/v1/evals/:eval_id/runs/:eval_run_id/cancel', () => {
    test('refuses a run under a sibling eval', async () => {
      const response = await authenticatedTestClient(scopedToken).post(
        `/api/v1/evals/${otherEvalId}/runs/evalrun_doesnotexist/cancel`
      );

      expect(response.status).toBe(403);
    });
  });

  describe('DELETE /api/v1/evals/:eval_id', () => {
    test('refuses a sibling eval', async () => {
      const response = await authenticatedTestClient(scopedToken).delete(
        `/api/v1/evals/${otherEvalId}`
      );

      expect(response.status).toBe(403);
    });

    test('reaches the eval the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken).delete(
        `/api/v1/evals/${allowedEvalId}`
      );

      expect(response.status).toBe(204);
    });
  });

  describe('DELETE /api/v1/datasets/:dataset_id', () => {
    test('refuses a sibling dataset', async () => {
      const response = await authenticatedTestClient(scopedToken).delete(
        `/api/v1/datasets/${otherDatasetId}`
      );

      expect(response.status).toBe(403);
    });
  });
});
