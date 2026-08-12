import { db } from 'src/db';

import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * Evaluations — datasets, evals, and synchronous runs
 * (docs/prd-evaluations.md, Phase 1).
 *
 * Every assertion drives the REST entry point. The scorer algebra itself is
 * covered directly in `lib/evaluationScorers.test.ts` (keep-list rule 1), and
 * the version pin's effect on the served config in
 * `lib/evaluationVersionPin.test.ts` — which this file cannot observe, because
 * `mockCreateGeneration` stands in for the whole generation path here.
 */
describe('Evaluations', () => {
  let adminToken: string;
  let userToken: string;
  let noPermToken: string;
  let projectId: string;
  let otherProjectId: string;
  let agentId: string;
  let schemaAgentId: string;
  let otherProjectAgentId: string;
  let otherProjectDatasetId: string;
  let providerId: string;
  let scopedToken: string;
  let projectKey: string;

  const AGENT_OUTPUT_SCHEMA = {
    type: 'object',
    required: ['category'],
    properties: { category: { type: 'string', enum: ['billing', 'other'] } },
  };

  const asUser = () => {
    return authenticatedTestClient(userToken);
  };

  const createDataset = async (name: string, description?: string) => {
    const res = await asUser()
      .post('/api/v1/datasets')
      .send({ project_id: projectId, name, description });
    expect(res.status).toBe(201);
    return res.body;
  };

  const addItem = async (
    datasetId: string,
    body: Record<string, unknown>
  ): Promise<Record<string, unknown>> => {
    const res = await asUser()
      .post(`/api/v1/datasets/${datasetId}/items`)
      .send(body);
    expect(res.status).toBe(201);
    return res.body;
  };

  const createEval = async (body: Record<string, unknown>) => {
    const res = await asUser()
      .post('/api/v1/evals')
      .send({ project_id: projectId, ...body });
    expect(res.status).toBe(201);
    return res.body;
  };

  /** A completed generation whose final text is `content`. */
  const completedGeneration = (
    id: string,
    content: string,
    object?: unknown
  ) => {
    return {
      id,
      traceId: `trc_${id}`,
      status: 'completed' as const,
      output: {
        model: 'test-model',
        content,
        finishReason: 'stop',
        ...(object === undefined ? {} : { object }),
      },
    };
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'evals',
      policyActions: [
        'evaluations:CreateDataset',
        'evaluations:ListDatasets',
        'evaluations:GetDataset',
        'evaluations:DeleteDataset',
        'evaluations:CreateEval',
        'evaluations:ListEvals',
        'evaluations:GetEval',
        'evaluations:DeleteEval',
        'evaluations:RunEval',
        'agents:CreateAgent',
        'agents:UpdateAgent',
        'generations:PurgeGenerationContent',
      ],
      createOtherProject: true,
    });

    adminToken = setup.adminToken;
    userToken = setup.userToken;
    noPermToken = setup.noPermToken as string;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId as string;

    const providerRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Evals Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });

    const agentRes = await asUser().post('/api/v1/agents').send({
      project_id: projectId,
      ai_provider_id: providerRes.body.id,
      name: 'Evals Agent',
      instructions: 'Be terse.',
    });
    providerId = providerRes.body.id;
    agentId = agentRes.body.id;

    const schemaAgentRes = await asUser().post('/api/v1/agents').send({
      project_id: projectId,
      ai_provider_id: providerRes.body.id,
      name: 'Evals Schema Agent',
      output_schema: AGENT_OUTPUT_SCHEMA,
    });
    schemaAgentId = schemaAgentRes.body.id;

    const otherProviderRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: otherProjectId,
        name: 'Other Evals Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    const otherAgentRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: otherProjectId,
        ai_provider_id: otherProviderRes.body.id,
        name: 'Other Project Agent',
      });
    otherProjectAgentId = otherAgentRes.body.id;

    const otherDatasetRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/datasets')
      .send({ project_id: otherProjectId, name: 'other-project-dataset' });
    otherProjectDatasetId = otherDatasetRes.body.id;

    // A principal whose policy is SRN-scoped to `projectId` — the shape a
    // project-scoped key has, and the only one that can observe cross-project
    // isolation (the wildcard user above can legitimately read both projects).
    scopedToken = await createScopedPrincipal({
      adminToken,
      projectId,
      username: 'evalsscoped',
      actions: ['evaluations:GetDataset', 'evaluations:GetEval'],
    });

    // A project-scoped API key, so a create with no `project_id` in the body
    // still resolves to exactly one project.
    const keyRes = await asUser()
      .post('/api/v1/api-keys')
      .send({
        project_id: projectId,
        policy_ids: [setup.policyId],
        name: 'Evals project key',
      });
    expect(keyRes.status).toBe(201);
    projectKey = keyRes.body.key;
  });

  afterEach(() => {
    // Shared spy: clear queued implementations and call counts, but never
    // restore — restoring would unwire it for every later test.
    jest.clearAllMocks();
  });

  // ── Datasets ─────────────────────────────────────────────────────────────

  describe('POST /api/v1/datasets', () => {
    test('creates a dataset and exposes the public id as `id`', async () => {
      const dataset = await createDataset('billing-suite', 'Billing questions');

      expect(dataset.id).toMatch(/^dset_/);
      expect(dataset.project_id).toBe(projectId);
      expect(dataset.name).toBe('billing-suite');
      expect(dataset.description).toBe('Billing questions');
      expect(dataset.created_at).toBeDefined();
    });

    test('rejects a duplicate name in the same project with 409', async () => {
      await createDataset('dup-suite');

      const res = await asUser()
        .post('/api/v1/datasets')
        .send({ project_id: projectId, name: 'dup-suite' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('NAME_CONFLICT');
    });

    test('rejects a missing name with 400', async () => {
      const res = await asUser()
        .post('/api/v1/datasets')
        .send({ project_id: projectId });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient
        .post('/api/v1/datasets')
        .send({ project_id: projectId, name: 'nope' });
      expect(res.status).toBe(401);
    });

    test('a user without the action returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .post('/api/v1/datasets')
        .send({ project_id: projectId, name: 'nope' });
      expect(res.status).toBe(403);
    });

    test('omitting description leaves it null', async () => {
      const res = await asUser()
        .post('/api/v1/datasets')
        .send({ project_id: projectId, name: 'terse-suite' });

      expect(res.status).toBe(201);
      expect(res.body.description).toBeNull();
    });

    test('a project-scoped key creates without naming the project', async () => {
      const res = await authenticatedTestClient(projectKey)
        .post('/api/v1/datasets')
        .send({ name: 'implicit-project-suite' });

      expect(res.status).toBe(201);
      expect(res.body.project_id).toBe(projectId);
    });
  });

  describe('GET / PUT / DELETE /api/v1/datasets/{dataset_id}', () => {
    test('lists datasets in the project', async () => {
      await createDataset('listed-suite');

      const res = await asUser().get(
        `/api/v1/datasets?project_id=${projectId}`
      );

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(
        res.body.data.some((row: { name: string }) => {
          return row.name === 'listed-suite';
        })
      ).toBe(true);
    });

    test('gets a dataset by id', async () => {
      const created = await createDataset('gettable-suite');

      const res = await asUser().get(`/api/v1/datasets/${created.id}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(created.id);
    });

    test('a dataset outside the caller’s project scope reads as not found', async () => {
      const res = await authenticatedTestClient(scopedToken).get(
        `/api/v1/datasets/${otherProjectDatasetId}`
      );
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });

    test('updates name and description', async () => {
      const created = await createDataset('renamable-suite', 'before');

      const res = await asUser()
        .put(`/api/v1/datasets/${created.id}`)
        .send({ name: 'renamed-suite', description: null });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('renamed-suite');
      expect(res.body.description).toBeNull();
    });

    test('deletes a dataset', async () => {
      const created = await createDataset('deletable-suite');

      const res = await asUser().delete(`/api/v1/datasets/${created.id}`);
      expect(res.status).toBe(204);

      const after = await asUser().get(`/api/v1/datasets/${created.id}`);
      expect(after.status).toBe(404);
    });

    test('unauthenticated get returns 401', async () => {
      const res = await testClient.get('/api/v1/datasets/dset_missing');
      expect(res.status).toBe(401);
    });

    test('an admin listing without a project filter sees every project', async () => {
      const res = await authenticatedTestClient(adminToken).get(
        '/api/v1/datasets'
      );

      expect(res.status).toBe(200);
      expect(
        res.body.data.some((row: { project_id: string }) => {
          return row.project_id === otherProjectId;
        })
      ).toBe(true);
    });

    test('updating only the description leaves the name alone', async () => {
      const created = await createDataset('description-only-suite');

      const res = await asUser()
        .put(`/api/v1/datasets/${created.id}`)
        .send({ description: 'now described' });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('description-only-suite');
      expect(res.body.description).toBe('now described');
    });
  });

  // ── Dataset items ────────────────────────────────────────────────────────

  describe('dataset items', () => {
    let datasetId: string;

    beforeAll(async () => {
      datasetId = (await createDataset('items-suite')).id;
    });

    test('adds an item with input, expected output, and metadata', async () => {
      const item = await addItem(datasetId, {
        input: [{ role: 'user', content: 'When is my invoice issued?' }],
        expected_output: 'On the first of each month.',
        metadata: { topic: 'billing' },
      });

      expect(item.id).toMatch(/^dsit_/);
      expect(item.dataset_id).toBe(datasetId);
      expect(item.expected_output).toBe('On the first of each month.');
      expect(item.metadata).toEqual({ topic: 'billing' });
      // Set only by the Phase 2 curation route.
      expect(item.source_generation_id).toBeNull();
    });

    test.each([
      ['a bare string', 'When is my invoice issued?'],
      ['an empty array', []],
      ['a message with no role', [{ content: 'hi' }]],
      ['a message with no content', [{ role: 'user' }]],
    ])('rejects %s as input with 400', async (_label, input) => {
      const res = await asUser()
        .post(`/api/v1/datasets/${datasetId}/items`)
        .send({ input });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('lists items oldest first', async () => {
      const listDataset = (await createDataset('ordered-items-suite')).id;
      await addItem(listDataset, { input: [{ role: 'user', content: 'one' }] });
      await addItem(listDataset, { input: [{ role: 'user', content: 'two' }] });

      const res = await asUser().get(`/api/v1/datasets/${listDataset}/items`);

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
      expect(res.body.data[0].input[0].content).toBe('one');
    });

    test('updates an item', async () => {
      const item = await addItem(datasetId, {
        input: [{ role: 'user', content: 'before' }],
      });

      const res = await asUser()
        .put(`/api/v1/datasets/${datasetId}/items/${item.id}`)
        .send({
          input: [{ role: 'user', content: 'after' }],
          expected_output: 'updated',
        });

      expect(res.status).toBe(200);
      expect(res.body.input[0].content).toBe('after');
      expect(res.body.expected_output).toBe('updated');
    });

    test('deletes an item', async () => {
      const item = await addItem(datasetId, {
        input: [{ role: 'user', content: 'temporary' }],
      });

      const res = await asUser().delete(
        `/api/v1/datasets/${datasetId}/items/${item.id}`
      );
      expect(res.status).toBe(204);

      const again = await asUser().delete(
        `/api/v1/datasets/${datasetId}/items/${item.id}`
      );
      expect(again.status).toBe(404);
    });

    test('an unknown item returns 404', async () => {
      const res = await asUser()
        .put(`/api/v1/datasets/${datasetId}/items/dsit_missing`)
        .send({ expected_output: 'x' });
      expect(res.status).toBe(404);
    });

    test('unauthenticated item create returns 401', async () => {
      const res = await testClient
        .post(`/api/v1/datasets/${datasetId}/items`)
        .send({ input: [{ role: 'user', content: 'hi' }] });
      expect(res.status).toBe(401);
    });

    test('a user without the action returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .post(`/api/v1/datasets/${datasetId}/items`)
        .send({ input: [{ role: 'user', content: 'hi' }] });
      expect(res.status).toBe(403);
    });

    test('an item with no reference answer or metadata stores nulls', async () => {
      const item = await addItem(datasetId, {
        input: [{ role: 'user', content: 'bare' }],
      });

      expect(item.expected_output).toBeNull();
      expect(item.metadata).toBeNull();
    });

    test('rejects non-object metadata with 400', async () => {
      const res = await asUser()
        .post(`/api/v1/datasets/${datasetId}/items`)
        .send({ input: [{ role: 'user', content: 'hi' }], metadata: 'billing' });

      expect(res.status).toBe(400);
    });

    test('clearing metadata on update stores null', async () => {
      const item = await addItem(datasetId, {
        input: [{ role: 'user', content: 'tagged' }],
        metadata: { topic: 'billing' },
      });

      const res = await asUser()
        .put(`/api/v1/datasets/${datasetId}/items/${item.id}`)
        .send({ metadata: null });

      expect(res.status).toBe(200);
      expect(res.body.metadata).toBeNull();
    });
  });

  // ── Evals ────────────────────────────────────────────────────────────────

  describe('POST /api/v1/evals', () => {
    let datasetId: string;

    beforeAll(async () => {
      datasetId = (await createDataset('eval-config-suite')).id;
      await addItem(datasetId, { input: [{ role: 'user', content: 'hi' }] });
    });

    test('creates an eval bound to an agent, a dataset, and scorers', async () => {
      const created = await createEval({
        name: 'basic-eval',
        agent_id: agentId,
        dataset_id: datasetId,
        scorers: [{ type: 'contains', value: 'invoice' }],
        pass_threshold: 0.5,
      });

      expect(created.id).toMatch(/^eval_/);
      expect(created.agent_id).toBe(agentId);
      expect(created.dataset_id).toBe(datasetId);
      expect(created.pass_threshold).toBe(0.5);
      expect(created.scorers).toEqual([{ type: 'contains', value: 'invoice' }]);
    });

    test('an agent in another project is rejected with 400', async () => {
      const res = await asUser()
        .post('/api/v1/evals')
        .send({
          project_id: projectId,
          name: 'cross-project-agent',
          agent_id: otherProjectAgentId,
          dataset_id: datasetId,
          scorers: [{ type: 'exact_match' }],
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('agent_id');
    });

    test('a dataset in another project is rejected with 400', async () => {
      const res = await asUser()
        .post('/api/v1/evals')
        .send({
          project_id: projectId,
          name: 'cross-project-dataset',
          agent_id: agentId,
          dataset_id: otherProjectDatasetId,
          scorers: [{ type: 'exact_match' }],
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('dataset_id');
    });

    test('an unknown scorer type is rejected with 400 naming the field', async () => {
      const res = await asUser()
        .post('/api/v1/evals')
        .send({
          project_id: projectId,
          name: 'bad-scorer',
          agent_id: agentId,
          dataset_id: datasetId,
          scorers: [{ type: 'vibes' }],
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('scorers.0.type');
    });

    test('llm_judge is rejected as a Phase 2 scorer', async () => {
      const res = await asUser()
        .post('/api/v1/evals')
        .send({
          project_id: projectId,
          name: 'judge-eval',
          agent_id: agentId,
          dataset_id: datasetId,
          scorers: [{ type: 'llm_judge' }],
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/Phase 2/);
    });

    test('an output_schema scorer against an agent with no output_schema is rejected', async () => {
      const res = await asUser()
        .post('/api/v1/evals')
        .send({
          project_id: projectId,
          name: 'schemaless-agent-eval',
          agent_id: agentId,
          dataset_id: datasetId,
          // Its own schema does not help: without an agent schema the platform
          // emits no structured output, so every item would score 0.
          scorers: [{ type: 'output_schema', schema: { type: 'object' } }],
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/requires the agent under test/);
    });

    test('an out-of-range pass_threshold is rejected with 400', async () => {
      const res = await asUser()
        .post('/api/v1/evals')
        .send({
          project_id: projectId,
          name: 'bad-threshold',
          agent_id: agentId,
          dataset_id: datasetId,
          scorers: [{ type: 'exact_match' }],
          pass_threshold: 1.5,
        });

      expect(res.status).toBe(400);
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.post('/api/v1/evals').send({
        project_id: projectId,
        name: 'unauth',
        agent_id: agentId,
        dataset_id: datasetId,
        scorers: [{ type: 'exact_match' }],
      });
      expect(res.status).toBe(401);
    });

    test('a user without the action returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .post('/api/v1/evals')
        .send({
          project_id: projectId,
          name: 'forbidden',
          agent_id: agentId,
          dataset_id: datasetId,
          scorers: [{ type: 'exact_match' }],
        });
      expect(res.status).toBe(403);
    });

    test('a project-scoped key creates without naming the project', async () => {
      const res = await authenticatedTestClient(projectKey)
        .post('/api/v1/evals')
        .send({
          name: 'implicit-project-eval',
          agent_id: agentId,
          dataset_id: datasetId,
          scorers: [{ type: 'exact_match' }],
        });

      expect(res.status).toBe(201);
      expect(res.body.project_id).toBe(projectId);
    });

    test('a non-string agent_id is rejected with 400', async () => {
      const res = await asUser()
        .post('/api/v1/evals')
        .send({
          project_id: projectId,
          name: 'numeric-agent',
          agent_id: 42,
          dataset_id: datasetId,
          scorers: [{ type: 'exact_match' }],
        });

      expect(res.status).toBe(400);
    });
  });

  describe('GET / PUT / DELETE /api/v1/evals/{eval_id}', () => {
    let datasetId: string;

    beforeAll(async () => {
      datasetId = (await createDataset('eval-crud-suite')).id;
      await addItem(datasetId, { input: [{ role: 'user', content: 'hi' }] });
    });

    test('lists and gets evals', async () => {
      const created = await createEval({
        name: 'listable-eval',
        agent_id: agentId,
        dataset_id: datasetId,
        scorers: [{ type: 'exact_match' }],
      });

      const list = await asUser().get(`/api/v1/evals?project_id=${projectId}`);
      expect(list.status).toBe(200);
      expect(
        list.body.data.some((row: { id: string }) => {
          return row.id === created.id;
        })
      ).toBe(true);

      const get = await asUser().get(`/api/v1/evals/${created.id}`);
      expect(get.status).toBe(200);
      expect(get.body.name).toBe('listable-eval');
    });

    test('updates the scorers and threshold', async () => {
      const created = await createEval({
        name: 'updatable-eval',
        agent_id: agentId,
        dataset_id: datasetId,
        scorers: [{ type: 'exact_match' }],
      });

      const res = await asUser()
        .put(`/api/v1/evals/${created.id}`)
        .send({
          scorers: [{ type: 'contains', value: 'yes' }],
          pass_threshold: null,
        });

      expect(res.status).toBe(200);
      expect(res.body.scorers).toEqual([{ type: 'contains', value: 'yes' }]);
      expect(res.body.pass_threshold).toBeNull();
    });

    test('swapping to an agent with no output_schema invalidates an output_schema scorer', async () => {
      const created = await createEval({
        name: 'schema-swap-eval',
        agent_id: schemaAgentId,
        dataset_id: datasetId,
        scorers: [{ type: 'output_schema' }],
      });

      const res = await asUser()
        .put(`/api/v1/evals/${created.id}`)
        .send({ agent_id: agentId });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/requires the agent under test/);
    });

    test('deletes an eval', async () => {
      const created = await createEval({
        name: 'deletable-eval',
        agent_id: agentId,
        dataset_id: datasetId,
        scorers: [{ type: 'exact_match' }],
      });

      const res = await asUser().delete(`/api/v1/evals/${created.id}`);
      expect(res.status).toBe(204);

      const after = await asUser().get(`/api/v1/evals/${created.id}`);
      expect(after.status).toBe(404);
    });

    test('an unknown eval returns 404', async () => {
      const res = await asUser().get('/api/v1/evals/eval_missing');
      expect(res.status).toBe(404);
    });
  });

  // ── Runs ─────────────────────────────────────────────────────────────────

  describe('POST /api/v1/evals/{eval_id}/runs — request contract', () => {
    let evalId: string;

    beforeAll(async () => {
      const datasetId = (await createDataset('run-contract-suite')).id;
      await addItem(datasetId, { input: [{ role: 'user', content: 'hi' }] });
      evalId = (
        await createEval({
          name: 'run-contract-eval',
          agent_id: agentId,
          dataset_id: datasetId,
          scorers: [{ type: 'exact_match' }],
        })
      ).id;
    });

    test('omitting `wait` is rejected with 400', async () => {
      const res = await asUser().post(`/api/v1/evals/${evalId}/runs`).send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('`wait: false` is rejected, naming async as a Phase 2 capability', async () => {
      const res = await asUser()
        .post(`/api/v1/evals/${evalId}/runs`)
        .send({ wait: false });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/Phase 2/);
    });

    test('an empty dataset is rejected rather than scored as a vacuous pass', async () => {
      const emptyDataset = (await createDataset('empty-suite')).id;
      const emptyEval = await createEval({
        name: 'empty-eval',
        agent_id: agentId,
        dataset_id: emptyDataset,
        scorers: [{ type: 'exact_match' }],
        pass_threshold: 0.5,
      });

      const res = await asUser()
        .post(`/api/v1/evals/${emptyEval.id}/runs`)
        .send({ wait: true });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/no items/);
    });

    test('a dataset over the 25-item sync cap is rejected, not partially scored', async () => {
      const bigDataset = (await createDataset('oversized-suite')).id;
      for (let index = 0; index < 26; index += 1) {
        await addItem(bigDataset, {
          input: [{ role: 'user', content: `q${index}` }],
        });
      }
      const bigEval = await createEval({
        name: 'oversized-eval',
        agent_id: agentId,
        dataset_id: bigDataset,
        scorers: [{ type: 'exact_match' }],
      });

      const res = await asUser()
        .post(`/api/v1/evals/${bigEval.id}/runs`)
        .send({ wait: true });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('25');
      expect(mockCreateGeneration).not.toHaveBeenCalled();
    });

    test('an unknown agent_version is rejected with 400', async () => {
      const res = await asUser()
        .post(`/api/v1/evals/${evalId}/runs`)
        .send({ wait: true, agent_version: 99 });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('agent_version 99');
    });

    test('a baseline that is not a run of this eval is rejected with 400', async () => {
      const res = await asUser()
        .post(`/api/v1/evals/${evalId}/runs`)
        .send({ wait: true, baseline_run_id: 'evrun_missing' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/not a run of this eval/);
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient
        .post(`/api/v1/evals/${evalId}/runs`)
        .send({ wait: true });
      expect(res.status).toBe(401);
    });

    test('a user without the action returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .post(`/api/v1/evals/${evalId}/runs`)
        .send({ wait: true });
      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/v1/evals/{eval_id}/runs — scoring', () => {
    let datasetId: string;
    let evalId: string;
    let itemIds: string[];

    beforeAll(async () => {
      datasetId = (await createDataset('scoring-suite')).id;
      const items = [
        await addItem(datasetId, {
          input: [{ role: 'user', content: 'q1' }],
          expected_output: 'Paris',
          metadata: { topic: 'geo' },
        }),
        await addItem(datasetId, {
          input: [{ role: 'user', content: 'q2' }],
          expected_output: 'Paris',
        }),
        await addItem(datasetId, {
          input: [{ role: 'user', content: 'q3' }],
          expected_output: 'Paris',
        }),
      ];
      itemIds = items.map((item) => {
        return item.id as string;
      });

      evalId = (
        await createEval({
          name: 'scoring-eval',
          agent_id: agentId,
          dataset_id: datasetId,
          scorers: [
            { type: 'exact_match' },
            { type: 'contains', value: 'Paris' },
            {
              type: 'json_logic',
              expression: { '==': [{ var: 'output' }, 'Paris'] },
            },
          ],
          pass_threshold: 0.6,
        })
      ).id;
    });

    test('scores every item, links a generation, and derives the run verdict', async () => {
      mockCreateGeneration
        .mockResolvedValueOnce(completedGeneration('gen_s1', 'Paris'))
        .mockResolvedValueOnce(completedGeneration('gen_s2', 'Paris'))
        .mockResolvedValueOnce(completedGeneration('gen_s3', 'Lyon'));

      const res = await asUser()
        .post(`/api/v1/evals/${evalId}/runs`)
        .send({ wait: true });

      expect(res.status).toBe(201);
      expect(res.body.id).toMatch(/^evrun_/);
      expect(res.body.status).toBe('completed');
      expect(res.body.item_count).toBe(3);
      expect(res.body.completed_count).toBe(3);
      expect(res.body.errored_count).toBe(0);
      expect(res.body.agent_version).toBe(1);
      expect(res.body.started_at).toBeDefined();
      expect(res.body.finished_at).toBeDefined();

      // Two of three items pass every scorer → pass rate 2/3 ≥ 0.6.
      expect(res.body.aggregate_scores.pass_rate).toBeCloseTo(2 / 3);
      expect(res.body.aggregate_scores.scored_item_count).toBe(3);
      expect(res.body.aggregate_scores.scorers.exact_match).toEqual({
        mean: 2 / 3,
        pass_rate: 2 / 3,
      });
      expect(res.body.passed).toBe(true);

      const results = await asUser().get(
        `/api/v1/evals/${evalId}/runs/${res.body.id}/results`
      );
      expect(results.status).toBe(200);
      expect(results.body.total).toBe(3);

      const [first] = results.body.data;
      expect(first.id).toMatch(/^evres_/);
      expect(first.dataset_item_id).toBe(itemIds[0]);
      expect(first.output).toBe('Paris');
      expect(first.passed).toBe(true);
      expect(first.error).toBeNull();
      expect(first.scores).toEqual([
        { scorer: 'exact_match', score: 1, passed: true },
        { scorer: 'contains', score: 1, passed: true },
        { scorer: 'json_logic', score: 1, passed: true },
      ]);

      const failing = results.body.data[2];
      expect(failing.passed).toBe(false);
      expect(failing.scores[0]).toEqual({
        scorer: 'exact_match',
        score: 0,
        passed: false,
      });
    });

    test('pins every item of the run to one agent version', async () => {
      mockCreateGeneration
        .mockResolvedValueOnce(completedGeneration('gen_p1', 'Paris'))
        .mockResolvedValueOnce(completedGeneration('gen_p2', 'Paris'))
        .mockResolvedValueOnce(completedGeneration('gen_p3', 'Paris'));

      const res = await asUser()
        .post(`/api/v1/evals/${evalId}/runs`)
        .send({ wait: true });

      expect(res.status).toBe(201);
      expect(mockCreateGeneration).toHaveBeenCalledTimes(3);

      const pins = mockCreateGeneration.mock.calls.map((call) => {
        return (call[0] as { pinnedAgentVersion?: number }).pinnedAgentVersion;
      });
      expect(pins).toEqual([1, 1, 1]);
      expect(res.body.agent_version).toBe(1);
    });

    test('a run below the threshold fails the verdict', async () => {
      mockCreateGeneration
        .mockResolvedValueOnce(completedGeneration('gen_f1', 'Lyon'))
        .mockResolvedValueOnce(completedGeneration('gen_f2', 'Lyon'))
        .mockResolvedValueOnce(completedGeneration('gen_f3', 'Paris'));

      const res = await asUser()
        .post(`/api/v1/evals/${evalId}/runs`)
        .send({ wait: true });

      expect(res.body.aggregate_scores.pass_rate).toBeCloseTo(1 / 3);
      expect(res.body.passed).toBe(false);
    });

    test('a requires_action generation errors the item instead of scoring it 0', async () => {
      mockCreateGeneration
        .mockResolvedValueOnce(completedGeneration('gen_r1', 'Paris'))
        .mockResolvedValueOnce({
          id: 'gen_r2',
          traceId: 'trc_r2',
          status: 'requires_action' as const,
          requiredAction: {
            type: 'submit_tool_outputs' as const,
            toolCalls: [{ id: 'call_1', toolName: 'lookup', args: {} }],
          },
        })
        .mockResolvedValueOnce(completedGeneration('gen_r3', 'Paris'));

      const res = await asUser()
        .post(`/api/v1/evals/${evalId}/runs`)
        .send({ wait: true });

      expect(res.status).toBe(201);
      expect(res.body.errored_count).toBe(1);
      expect(res.body.completed_count).toBe(2);
      // The paused item is excluded, not counted as a failure — so the two
      // scorable items give a clean 1.0 rather than a fabricated regression.
      expect(res.body.aggregate_scores.scored_item_count).toBe(2);
      expect(res.body.aggregate_scores.pass_rate).toBe(1);
      expect(res.body.passed).toBe(true);

      const results = await asUser().get(
        `/api/v1/evals/${evalId}/runs/${res.body.id}/results`
      );
      const errored = results.body.data[1];
      expect(errored.error).toMatch(/requires_action/);
      expect(errored.scores).toEqual([]);
      expect(errored.output).toBeNull();
    });

    test('a generation that throws errors the item and leaves the run completed', async () => {
      mockCreateGeneration
        .mockRejectedValueOnce(new Error('provider exploded'))
        .mockResolvedValueOnce(completedGeneration('gen_e2', 'Paris'))
        .mockResolvedValueOnce(completedGeneration('gen_e3', 'Paris'));

      const res = await asUser()
        .post(`/api/v1/evals/${evalId}/runs`)
        .send({ wait: true });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('completed');
      expect(res.body.errored_count).toBe(1);

      const results = await asUser().get(
        `/api/v1/evals/${evalId}/runs/${res.body.id}/results`
      );
      expect(results.body.data[0].error).toBe('provider exploded');
    });

    test('lists runs newest first and gets one by id', async () => {
      const list = await asUser().get(`/api/v1/evals/${evalId}/runs`);
      expect(list.status).toBe(200);
      expect(list.body.total).toBeGreaterThan(0);

      const get = await asUser().get(
        `/api/v1/evals/${evalId}/runs/${list.body.data[0].id}`
      );
      expect(get.status).toBe(200);
      expect(get.body.eval_id).toBe(evalId);
    });

    test('an unknown run returns 404', async () => {
      const res = await asUser().get(
        `/api/v1/evals/${evalId}/runs/evrun_missing`
      );
      expect(res.status).toBe(404);
    });

    test('a terminal run of the same eval is accepted as a baseline', async () => {
      const runs = await asUser().get(`/api/v1/evals/${evalId}/runs`);
      const baselineId = runs.body.data[0].id;

      mockCreateGeneration
        .mockResolvedValueOnce(completedGeneration('gen_b1', 'Paris'))
        .mockResolvedValueOnce(completedGeneration('gen_b2', 'Paris'))
        .mockResolvedValueOnce(completedGeneration('gen_b3', 'Paris'));

      const res = await asUser()
        .post(`/api/v1/evals/${evalId}/runs`)
        .send({ wait: true, baseline_run_id: baselineId });

      expect(res.status).toBe(201);
      expect(res.body.baseline_run_id).toBe(baselineId);
    });
  });

  // ── Structured output ────────────────────────────────────────────────────

  describe('structured output scorers', () => {
    let evalId: string;

    beforeAll(async () => {
      const datasetId = (await createDataset('schema-suite')).id;
      await addItem(datasetId, {
        input: [{ role: 'user', content: 'classify this' }],
        expected_output: 'billing',
      });

      evalId = (
        await createEval({
          name: 'schema-eval',
          agent_id: schemaAgentId,
          dataset_id: datasetId,
          scorers: [
            { type: 'output_schema' },
            { type: 'contains', value: 'billing' },
            {
              type: 'json_logic',
              expression: {
                '==': [{ var: 'object.category' }, { var: 'expected' }],
              },
            },
          ],
        })
      ).id;
    });

    test('text scorers still work against a schema-bound agent', async () => {
      // Pins the PRD's one unverified premise: an agent with an
      // `output_schema` must still emit non-empty `content`, otherwise
      // `contains` / `exact_match` would be meaningless against it.
      const generation = completedGeneration(
        'gen_o1',
        '{"category":"billing"}',
        { category: 'billing' }
      );
      expect(generation.output.content).not.toBe('');

      mockCreateGeneration.mockResolvedValueOnce(generation);

      const res = await asUser()
        .post(`/api/v1/evals/${evalId}/runs`)
        .send({ wait: true });

      expect(res.status).toBe(201);
      const results = await asUser().get(
        `/api/v1/evals/${evalId}/runs/${res.body.id}/results`
      );
      expect(results.body.data[0].scores).toEqual([
        { scorer: 'output_schema', score: 1, passed: true },
        { scorer: 'contains', score: 1, passed: true },
        { scorer: 'json_logic', score: 1, passed: true },
      ]);
    });

    test('a completed generation with no structured object scores 0 on output_schema', async () => {
      mockCreateGeneration.mockResolvedValueOnce(
        completedGeneration('gen_o2', 'billing')
      );

      const res = await asUser()
        .post(`/api/v1/evals/${evalId}/runs`)
        .send({ wait: true });

      const results = await asUser().get(
        `/api/v1/evals/${evalId}/runs/${res.body.id}/results`
      );
      const [outputSchema, contains, jsonLogic] = results.body.data[0].scores;

      expect(outputSchema).toEqual({
        scorer: 'output_schema',
        score: 0,
        passed: false,
      });
      // The text scorer still reads `content`, and `object` is simply absent
      // for the json_logic var — falsy, not an error.
      expect(contains.score).toBe(1);
      expect(jsonLogic.score).toBe(0);
    });

    test('a run becomes unrunnable when the agent loses its output_schema', async () => {
      const strandedRes = await asUser().post('/api/v1/agents').send({
        project_id: projectId,
        ai_provider_id: providerId,
        name: 'Stranded Schema Agent',
        output_schema: AGENT_OUTPUT_SCHEMA,
      });
      expect(strandedRes.status).toBe(201);
      const strandedAgentId = strandedRes.body.id;

      const datasetId = (await createDataset('stranded-suite')).id;
      await addItem(datasetId, { input: [{ role: 'user', content: 'hi' }] });

      const stranded = await createEval({
        name: 'stranded-eval',
        agent_id: strandedAgentId,
        dataset_id: datasetId,
        scorers: [{ type: 'output_schema' }],
      });

      // The agent's schema is mutable, so the create-time check is only
      // best-effort; the run-start re-check is the authoritative one.
      await asUser()
        .patch(`/api/v1/agents/${strandedAgentId}`)
        .send({ output_schema: null });

      const res = await asUser()
        .post(`/api/v1/evals/${stranded.id}/runs`)
        .send({ wait: true });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/requires the agent under test/);
    });
  });

  // ── Snapshot durability and erasure ──────────────────────────────────────

  describe('result durability', () => {
    test('editing then deleting an item leaves the run results intact', async () => {
      const datasetId = (await createDataset('frozen-suite')).id;
      const item = await addItem(datasetId, {
        input: [{ role: 'user', content: 'original question' }],
        expected_output: 'original answer',
      });
      const frozen = await createEval({
        name: 'frozen-eval',
        agent_id: agentId,
        dataset_id: datasetId,
        scorers: [{ type: 'exact_match' }],
      });

      mockCreateGeneration.mockResolvedValueOnce(
        completedGeneration('gen_fz1', 'original answer')
      );
      const run = await asUser()
        .post(`/api/v1/evals/${frozen.id}/runs`)
        .send({ wait: true });
      expect(run.status).toBe(201);

      await asUser()
        .put(`/api/v1/datasets/${datasetId}/items/${item.id}`)
        .send({
          input: [{ role: 'user', content: 'edited question' }],
          expected_output: 'edited answer',
        });
      await asUser().delete(`/api/v1/datasets/${datasetId}/items/${item.id}`);

      const results = await asUser().get(
        `/api/v1/evals/${frozen.id}/runs/${run.body.id}/results`
      );

      expect(results.status).toBe(200);
      const [result] = results.body.data;
      expect(result.dataset_item_id).toBeNull();
      expect(result.input[0].content).toBe('original question');
      expect(result.expected_output).toBe('original answer');
      expect(result.passed).toBe(true);
    });

    test('purging a linked generation redacts the copied output but keeps the scores', async () => {
      const datasetId = (await createDataset('purge-suite')).id;
      await addItem(datasetId, {
        input: [{ role: 'user', content: 'sensitive question' }],
        expected_output: 'sensitive answer',
      });
      const purgeEval = await createEval({
        name: 'purge-eval',
        agent_id: agentId,
        dataset_id: datasetId,
        scorers: [{ type: 'exact_match' }],
      });

      // A real Generation row is needed for the FK link and the purge to have
      // anything to cascade from. No entry point creates one while
      // `createGeneration` is mocked, so it is seeded directly and the mock is
      // pointed at its public id.
      const agentRow = await db.Agent.findOne({
        where: { publicId: agentId },
      });
      const projectRow = await db.Project.findOne({
        where: { publicId: projectId },
      });
      const trace = await db.Trace.create({
        projectId: projectRow!.id as number,
        agentId: agentRow!.id as number,
        status: 'completed',
      });
      const generation = await db.Generation.create({
        projectId: projectRow!.id as number,
        agentId: agentRow!.id as number,
        traceId: trace.id as number,
        status: 'completed',
        startedAt: new Date(),
      });

      mockCreateGeneration.mockResolvedValueOnce(
        completedGeneration(generation.publicId, 'sensitive answer')
      );
      const run = await asUser()
        .post(`/api/v1/evals/${purgeEval.id}/runs`)
        .send({ wait: true });
      expect(run.status).toBe(201);

      const before = await asUser().get(
        `/api/v1/evals/${purgeEval.id}/runs/${run.body.id}/results`
      );
      expect(before.body.data[0].generation_id).toBe(generation.publicId);
      expect(before.body.data[0].output).toBe('sensitive answer');

      const purge = await asUser().delete(
        `/api/v1/generations/${generation.publicId}/content`
      );
      expect(purge.status).toBe(200);

      const after = await asUser().get(
        `/api/v1/evals/${purgeEval.id}/runs/${run.body.id}/results`
      );
      const [result] = after.body.data;

      expect(result.output).toBeNull();
      // The run's own record survives: the verdict stays meaningful.
      expect(result.scores).toEqual([
        { scorer: 'exact_match', score: 1, passed: true },
      ]);
      expect(result.passed).toBe(true);
      expect(result.input[0].content).toBe('sensitive question');
      expect(result.expected_output).toBe('sensitive answer');
    });
  });
});
