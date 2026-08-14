import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { db } from 'src/db';
import { finalizeIfUnclaimed } from 'src/lib/evaluationRunExecution';
import {
  drainEvalQueueOnce,
  kickEvalWorker,
  reapAbandonedEvalRuns,
} from 'src/lib/evaluationWorker';
import { eventBus, type SoatEvent } from 'src/lib/eventBus';

import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * Evaluations — datasets, evals, and runs (the evaluations module doc).
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
    // The in-process kick is disabled so queued runs are driven *explicitly* by
    // `drainEvalQueueOnce` below: a background kick racing the assertions would
    // execute items with no queued `mockCreateGeneration` implementation.
    process.env.EVAL_WORKER_DISABLED = 'true';

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

  afterAll(() => {
    delete process.env.EVAL_WORKER_DISABLED;
  });

  afterEach(async () => {
    // Shared spy: clear queued implementations and call counts, but never
    // restore — restoring would unwire it for every later test.
    jest.clearAllMocks();
    // The eval queue is shared process state, so a test that starts a queued run
    // without draining it would otherwise hand its tasks to the next test's
    // drain (and eat that test's queued generation mocks). Every test that cares
    // about the queue creates what it needs, so nothing depends on a task
    // surviving past the test that enqueued it.
    await db.EvalRunTask.destroy({ where: {}, truncate: true });
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
      const res =
        await authenticatedTestClient(adminToken).get('/api/v1/datasets');

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
        .send({
          input: [{ role: 'user', content: 'hi' }],
          metadata: 'billing',
        });

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

    test('an llm_judge scorer without a pass_threshold is rejected', async () => {
      const res = await asUser()
        .post('/api/v1/evals')
        .send({
          project_id: projectId,
          name: 'judge-no-threshold-eval',
          agent_id: agentId,
          dataset_id: datasetId,
          scorers: [{ type: 'llm_judge', prompt: 'rate {{output}}' }],
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/pass_threshold is required/);
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

    // Phase 1 required `wait` precisely so this default could arrive without
    // changing any existing caller's behavior: omitting it used to be a 400, so
    // no caller can have been relying on it meaning "synchronous".
    test('omitting `wait` queues the run, matching the documented default', async () => {
      const res = await asUser().post(`/api/v1/evals/${evalId}/runs`).send({});

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('queued');
    });

    test('a non-boolean `wait` is rejected with 400', async () => {
      const res = await asUser()
        .post(`/api/v1/evals/${evalId}/runs`)
        .send({ wait: 'yes' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('an over-cap dataset is accepted for a queued run — the cap is sync-only', async () => {
      const bigDataset = (await createDataset('queued-oversized-suite')).id;
      for (let index = 0; index < 26; index += 1) {
        await addItem(bigDataset, {
          input: [{ role: 'user', content: `q${index}` }],
        });
      }
      const bigEval = await createEval({
        name: 'queued-oversized-eval',
        agent_id: agentId,
        dataset_id: bigDataset,
        scorers: [{ type: 'exact_match' }],
      });

      const res = await asUser()
        .post(`/api/v1/evals/${bigEval.id}/runs`)
        .send({ wait: false });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('queued');
      expect(res.body.item_count).toBe(26);
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

  // ── Asynchronous runs on the queue (Phase 2) ─────────────────────────────

  describe('asynchronous eval runs', () => {
    let evalId: string;
    let itemIds: string[];

    beforeAll(async () => {
      const datasetId = (await createDataset('async-suite')).id;
      itemIds = [];
      for (const content of ['a', 'b']) {
        const item = await addItem(datasetId, {
          input: [{ role: 'user', content }],
          expected_output: 'Paris',
        });
        itemIds.push(item.id as string);
      }

      evalId = (
        await createEval({
          name: 'async-eval',
          agent_id: agentId,
          dataset_id: datasetId,
          scorers: [{ type: 'exact_match' }],
          pass_threshold: 0.5,
        })
      ).id;
    });

    const startQueued = async () => {
      const res = await asUser()
        .post(`/api/v1/evals/${evalId}/runs`)
        .send({ wait: false });
      expect(res.status).toBe(201);
      return res.body;
    };

    test('returns a queued run immediately, with nothing scored yet', async () => {
      const run = await startQueued();

      expect(run.status).toBe('queued');
      expect(run.item_count).toBe(2);
      expect(run.completed_count).toBe(0);
      expect(run.aggregate_scores).toBeNull();
      expect(run.passed).toBeNull();
      expect(run.started_at).toBeNull();
      // A run started through the API has no schedule origin; `trigger_id` is
      // only set when a trigger fired it (Phase 3).
      expect(run.trigger_id).toBeNull();
      // Not a single generation yet — the response came back before any work.
      expect(mockCreateGeneration).not.toHaveBeenCalled();
    });

    test('enqueues exactly one task per dataset item', async () => {
      const run = await startQueued();
      const runRow = await db.EvalRun.findOne({
        where: { publicId: run.id },
      });

      expect(
        await db.EvalRunTask.count({
          where: { evalRunId: runRow!.id as number },
        })
      ).toBe(2);
    });

    test('the worker scores every item and settles the run', async () => {
      const run = await startQueued();

      mockCreateGeneration
        .mockResolvedValueOnce(completedGeneration('gen_q1', 'Paris'))
        .mockResolvedValueOnce(completedGeneration('gen_q2', 'Lyon'));

      expect(await drainEvalQueueOnce()).toBe(2);
      expect(mockCreateGeneration).toHaveBeenCalledTimes(2);

      const after = await asUser().get(
        `/api/v1/evals/${evalId}/runs/${run.id}`
      );
      expect(after.body.status).toBe('completed');
      expect(after.body.completed_count).toBe(2);
      expect(after.body.errored_count).toBe(0);
      expect(after.body.aggregate_scores.pass_rate).toBeCloseTo(0.5);
      // One of two items matched, and the eval's threshold is 0.5.
      expect(after.body.passed).toBe(true);
      expect(after.body.finished_at).not.toBeNull();

      const results = await asUser().get(
        `/api/v1/evals/${evalId}/runs/${run.id}/results`
      );
      expect(results.body.total).toBe(2);
      expect(
        results.body.data.map((result: { dataset_item_id: string }) => {
          return result.dataset_item_id;
        })
      ).toEqual(expect.arrayContaining(itemIds));
    });

    test('every task is acked, so a later drain finds nothing', async () => {
      await startQueued();
      mockCreateGeneration
        .mockResolvedValueOnce(completedGeneration('gen_q3', 'Paris'))
        .mockResolvedValueOnce(completedGeneration('gen_q4', 'Paris'));

      await drainEvalQueueOnce();
      expect(await drainEvalQueueOnce()).toBe(0);
      expect(mockCreateGeneration).toHaveBeenCalledTimes(2);
    });

    // At-least-once delivery: a redelivered item must re-run into the *same*
    // result row rather than adding a second one, or the run would count an item
    // twice and its pass rate would be wrong. Redelivery is exercised while the
    // run is still in flight, which is when it actually happens — once a run has
    // settled, the worker drops its tasks without spending a generation on them.
    test('a redelivered item task inserts no duplicate result', async () => {
      const run = await startQueued();
      const runRow = await db.EvalRun.findOne({ where: { publicId: run.id } });
      const runDbId = runRow!.id as number;

      // Score one of the two items, leaving the run `running` with work left.
      mockCreateGeneration.mockResolvedValueOnce(
        completedGeneration('gen_r1', 'Paris')
      );
      expect(await drainEvalQueueOnce({ limit: 1 })).toBe(1);

      const [scored] = await db.EvalResult.findAll({
        where: { evalRunId: runDbId },
      });
      const replayedItemId = scored.datasetItemId as number;

      // Re-enqueue that item — exactly what an expired lease redelivers.
      await db.EvalRunTask.create({
        evalRunId: runDbId,
        datasetItemId: replayedItemId,
        availableAt: new Date(),
        attempts: 1,
      });

      mockCreateGeneration
        .mockResolvedValueOnce(completedGeneration('gen_r2', 'Paris'))
        .mockResolvedValueOnce(completedGeneration('gen_r3', 'Paris'));
      expect(await drainEvalQueueOnce()).toBe(2);

      // The item really did run twice — this is not a "nothing happened" pass.
      expect(mockCreateGeneration).toHaveBeenCalledTimes(3);
      expect(
        await db.EvalResult.count({
          where: { evalRunId: runDbId, datasetItemId: replayedItemId },
        })
      ).toBe(1);
      // Two items, two rows — the replay did not inflate the run.
      expect(await db.EvalResult.count({ where: { evalRunId: runDbId } })).toBe(
        2
      );

      const settled = await asUser().get(
        `/api/v1/evals/${evalId}/runs/${run.id}`
      );
      expect(settled.body.status).toBe('completed');
      expect(settled.body.completed_count).toBe(2);
    });

    test('a queued run with an over-cap dataset needs no cap exemption', async () => {
      // Guards the split: the 25-item cap is a property of synchronous
      // execution, so a queued run of the same eval must not inherit it.
      const bigDataset = (await createDataset('async-oversized-suite')).id;
      for (let index = 0; index < 26; index += 1) {
        await addItem(bigDataset, {
          input: [{ role: 'user', content: `q${index}` }],
        });
      }
      const bigEval = await createEval({
        name: 'async-oversized-eval',
        agent_id: agentId,
        dataset_id: bigDataset,
        scorers: [{ type: 'exact_match' }],
      });

      const res = await asUser()
        .post(`/api/v1/evals/${bigEval.id}/runs`)
        .send({ wait: false });

      expect(res.status).toBe(201);
      expect(res.body.item_count).toBe(26);
    });
  });

  // ── Canceling a run (Phase 2) ────────────────────────────────────────────

  describe('POST /api/v1/evals/{eval_id}/runs/{eval_run_id}/cancel', () => {
    let evalId: string;

    beforeAll(async () => {
      const datasetId = (await createDataset('cancel-suite')).id;
      await addItem(datasetId, { input: [{ role: 'user', content: 'a' }] });
      await addItem(datasetId, { input: [{ role: 'user', content: 'b' }] });

      evalId = (
        await createEval({
          name: 'cancel-eval',
          agent_id: agentId,
          dataset_id: datasetId,
          scorers: [{ type: 'exact_match' }],
        })
      ).id;
    });

    const startQueued = async () => {
      const res = await asUser()
        .post(`/api/v1/evals/${evalId}/runs`)
        .send({ wait: false });
      expect(res.status).toBe(201);
      return res.body;
    };

    test('cancels a queued run and drops its outstanding work', async () => {
      const run = await startQueued();

      const res = await asUser().post(
        `/api/v1/evals/${evalId}/runs/${run.id}/cancel`
      );

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('canceled');
      expect(res.body.finished_at).not.toBeNull();

      const runRow = await db.EvalRun.findOne({ where: { publicId: run.id } });
      expect(
        await db.EvalRunTask.count({
          where: { evalRunId: runRow!.id as number },
        })
      ).toBe(0);
    });

    test('a canceled run stops spending: the worker runs none of its items', async () => {
      const run = await startQueued();
      await asUser().post(`/api/v1/evals/${evalId}/runs/${run.id}/cancel`);

      expect(await drainEvalQueueOnce()).toBe(0);
      expect(mockCreateGeneration).not.toHaveBeenCalled();
    });

    // A partial roll-up in the field a completed run uses would read as a
    // whole-dataset verdict — the same failure the sync cap exists to prevent.
    test('keeps results already scored but publishes no aggregate', async () => {
      const run = await startQueued();
      const runRow = await db.EvalRun.findOne({ where: { publicId: run.id } });
      const runDbId = runRow!.id as number;

      // Drive one of the two items, then cancel before the second.
      mockCreateGeneration.mockResolvedValueOnce(
        completedGeneration('gen_c1', 'Paris')
      );
      await drainEvalQueueOnce({ limit: 1 });
      expect(mockCreateGeneration).toHaveBeenCalledTimes(1);

      const res = await asUser().post(
        `/api/v1/evals/${evalId}/runs/${run.id}/cancel`
      );

      expect(res.status).toBe(200);
      expect(res.body.aggregate_scores).toBeNull();
      expect(res.body.completed_count).toBe(1);
      expect(await db.EvalResult.count({ where: { evalRunId: runDbId } })).toBe(
        1
      );
    });

    // The in-flight race: a worker that already claimed its batch is past the
    // liveness check, so it keeps executing and writing results after the cancel
    // settles the run. Counters frozen at the cancel instant therefore
    // under-report what ran — and `aggregate_scores` is deliberately null on a
    // canceled run, so they are the only remaining signal of what was paid for.
    test('counters reconcile with results written after the cancel', async () => {
      const run = await startQueued();
      const runRow = await db.EvalRun.findOne({ where: { publicId: run.id } });
      const runDbId = runRow!.id as number;

      let releaseGeneration!: () => void;
      let signalStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });

      mockCreateGeneration.mockImplementationOnce(() => {
        signalStarted();
        return new Promise((resolve) => {
          releaseGeneration = () => {
            resolve(completedGeneration('gen_c9', 'Paris'));
          };
        });
      });

      // Claim and begin one item, then cancel while it is still in flight.
      const draining = drainEvalQueueOnce({ limit: 1 });
      await started;

      const res = await asUser().post(
        `/api/v1/evals/${evalId}/runs/${run.id}/cancel`
      );
      expect(res.status).toBe(200);
      expect(res.body.completed_count).toBe(0);

      releaseGeneration();
      await draining;

      // The in-flight item finished and wrote its result after the cancel.
      expect(await db.EvalResult.count({ where: { evalRunId: runDbId } })).toBe(
        1
      );

      const after = await asUser().get(
        `/api/v1/evals/${evalId}/runs/${run.id}`
      );
      expect(after.body.status).toBe('canceled');
      // Still no verdict — a partial roll-up must not read as a whole-dataset one.
      expect(after.body.aggregate_scores).toBeNull();
      // But the counts must describe what actually ran.
      expect(after.body.completed_count).toBe(1);
      expect(after.body.errored_count).toBe(0);
    });

    test('a finished run cannot be canceled', async () => {
      mockCreateGeneration
        .mockResolvedValueOnce(completedGeneration('gen_c2', 'x'))
        .mockResolvedValueOnce(completedGeneration('gen_c3', 'x'));
      const finished = await asUser()
        .post(`/api/v1/evals/${evalId}/runs`)
        .send({ wait: true });
      expect(finished.body.status).toBe('completed');
      expect(mockCreateGeneration).toHaveBeenCalledTimes(2);

      const res = await asUser().post(
        `/api/v1/evals/${evalId}/runs/${finished.body.id}/cancel`
      );

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/already finished/);
    });

    test('an unknown run returns 404', async () => {
      const res = await asUser().post(
        `/api/v1/evals/${evalId}/runs/evrun_missing/cancel`
      );
      expect(res.status).toBe(404);
    });

    test('unauthenticated returns 401', async () => {
      const res = await testClient.post(
        `/api/v1/evals/${evalId}/runs/evrun_x/cancel`
      );
      expect(res.status).toBe(401);
    });

    test('a user without evaluations:RunEval returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken).post(
        `/api/v1/evals/${evalId}/runs/evrun_x/cancel`
      );
      expect(res.status).toBe(403);
    });
  });

  // ── The lease reaper (Phase 2) ───────────────────────────────────────────

  describe('reapAbandonedEvalRuns', () => {
    let evalId: string;

    beforeAll(async () => {
      const datasetId = (await createDataset('reaper-suite')).id;
      await addItem(datasetId, { input: [{ role: 'user', content: 'a' }] });
      await addItem(datasetId, { input: [{ role: 'user', content: 'b' }] });

      evalId = (
        await createEval({
          name: 'reaper-eval',
          agent_id: agentId,
          dataset_id: datasetId,
          scorers: [{ type: 'exact_match' }],
        })
      ).id;
    });

    /** A far-future `now`, so the grace period has certainly elapsed. */
    const wellPastGrace = () => {
      return new Date(Date.now() + 86_400_000);
    };

    // This is the Phase 1 debt: a client that disconnected mid-run left the row
    // `running` with nothing to clean it. It must settle, so a gate waiting on a
    // verdict stops waiting.
    test('settles an abandoned run as failed rather than leaving it running', async () => {
      const evaluation = await db.Eval.findOne({ where: { publicId: evalId } });
      const abandoned = await db.EvalRun.create({
        evalId: evaluation!.id as number,
        agentVersion: 1,
        status: 'running',
        itemCount: 2,
        startedAt: new Date(),
      });

      // The reaper sweeps every stale run in the database, so the assertion is
      // about this run's outcome rather than a global count the rest of the file
      // would perturb.
      await reapAbandonedEvalRuns({ now: wellPastGrace() });

      await abandoned.reload();
      expect(abandoned.status).toBe('failed');
      expect(abandoned.finishedAt).not.toBeNull();
    });

    // The opposite treatment: every measurement is present, so the run is
    // finalized rather than thrown away.
    test('finalizes a run whose items all scored but never settled', async () => {
      const run = await asUser()
        .post(`/api/v1/evals/${evalId}/runs`)
        .send({ wait: false });
      const runRow = await db.EvalRun.findOne({
        where: { publicId: run.body.id },
      });

      mockCreateGeneration
        .mockResolvedValueOnce(completedGeneration('gen_x1', 'Paris'))
        .mockResolvedValueOnce(completedGeneration('gen_x2', 'Paris'));
      await drainEvalQueueOnce();
      expect(mockCreateGeneration).toHaveBeenCalledTimes(2);

      // Rewind the run to the state a crash between the last ack and the
      // update would have left: results present, nothing settled. Reloaded
      // first because `instance.update` writes only fields that differ from the
      // in-memory copy — a stale instance would silently keep `finished_at`,
      // and the reaper's finalize claim is guarded on exactly that column.
      await runRow!.reload();
      await runRow!.update({
        status: 'running',
        aggregateScores: null,
        finishedAt: null,
      });

      await reapAbandonedEvalRuns({ now: wellPastGrace() });

      await runRow!.reload();
      expect(runRow!.status).toBe('completed');
      expect(runRow!.aggregateScores).not.toBeNull();
    });

    test('leaves a run with queued work alone — the drain sweep owns it', async () => {
      const run = await asUser()
        .post(`/api/v1/evals/${evalId}/runs`)
        .send({ wait: false });

      await reapAbandonedEvalRuns({ now: wellPastGrace() });

      const after = await asUser().get(
        `/api/v1/evals/${evalId}/runs/${run.body.id}`
      );
      expect(after.body.status).toBe('queued');
    });

    test('leaves a fresh run alone until the grace period elapses', async () => {
      const run = await asUser()
        .post(`/api/v1/evals/${evalId}/runs`)
        .send({ wait: false });

      // Real `now`: the run was created seconds ago, well inside the grace
      // period, so a legitimately slow synchronous run is never mistaken for an
      // abandoned one.
      expect(await reapAbandonedEvalRuns()).toBe(0);

      const after = await asUser().get(
        `/api/v1/evals/${evalId}/runs/${run.body.id}`
      );
      expect(after.body.status).toBe('queued');
    });
  });

  // ── Lifecycle webhooks (Phase 2) ─────────────────────────────────────────

  describe('eval run lifecycle events', () => {
    let evalId: string;

    beforeAll(async () => {
      const datasetId = (await createDataset('events-suite')).id;
      await addItem(datasetId, {
        input: [{ role: 'user', content: 'a' }],
        expected_output: 'Paris',
      });

      evalId = (
        await createEval({
          name: 'events-eval',
          agent_id: agentId,
          dataset_id: datasetId,
          scorers: [{ type: 'exact_match' }],
          pass_threshold: 1,
        })
      ).id;
    });

    /**
     * The eval-run events emitted while `action` runs.
     *
     * `emitResourceEvent` dispatches fire-and-forget and resolves the project
     * public id with a real DB read first, so the emit lands *after* the action
     * resolves. The window therefore polls for `expected` events on a bound
     * rather than sleeping a fixed settling time (`.claude/rules/tests.md`);
     * A run other than the one under test can also settle inside the window
     * (the reaper sweeps every stale run), so the predicate names *this* run
     * rather than counting events.
     */
    const withCapture = async (args: {
      action: () => Promise<void>;
      /**
       * Stops the window as soon as this holds. Omit to wait the whole bound
       * out, which is what makes "no event fired" a real assertion.
       */
      until?: (events: SoatEvent[]) => boolean;
    }): Promise<SoatEvent[]> => {
      const captured: SoatEvent[] = [];
      const handler = (event: SoatEvent) => {
        if (event.type.startsWith('eval_run.')) captured.push(event);
      };
      eventBus.on('soat:event', handler);
      try {
        await args.action();
        for (let tick = 0; tick < 100; tick += 1) {
          if (args.until?.(captured)) break;
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 10);
          });
        }
      } finally {
        // Never leak a listener onto the shared bus: it would fire for every
        // later test in the run and break under randomized file order.
        eventBus.off('soat:event', handler);
      }
      return captured;
    };

    test('a completed run fires eval_run.completed exactly once, with the verdict', async () => {
      let runId = '';
      const events = await withCapture({
        until: (captured) => {
          return captured.length >= 1;
        },
        action: async () => {
          mockCreateGeneration.mockResolvedValueOnce(
            completedGeneration('gen_e1', 'Paris')
          );
          const res = await asUser()
            .post(`/api/v1/evals/${evalId}/runs`)
            .send({ wait: true });
          runId = res.body.id as string;
        },
      });

      expect(events).toHaveLength(1);
      const [event] = events;
      expect(event.type).toBe('eval_run.completed');
      expect(event.resourceType).toBe('eval_run');
      expect(event.resourceId).toBe(runId);
      // The payload is the promotion gate's input: a consumer must be able to
      // decide from the event alone, without a second call that could fail open.
      expect(event.data).toEqual({
        eval_id: evalId,
        eval_run_id: runId,
        passed: true,
        aggregate_scores: expect.objectContaining({ pass_rate: 1 }),
      });
    });

    test('a queued run fires the event once, from the worker that settles it', async () => {
      const events = await withCapture({
        until: (captured) => {
          return captured.length >= 1;
        },
        action: async () => {
          await asUser()
            .post(`/api/v1/evals/${evalId}/runs`)
            .send({ wait: false });
          mockCreateGeneration.mockResolvedValueOnce(
            completedGeneration('gen_e2', 'Lyon')
          );
          await drainEvalQueueOnce();
        },
      });

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('eval_run.completed');
      expect(events[0].data.passed).toBe(false);
    });

    test('an abandoned run fires eval_run.failed, so a gate stops waiting', async () => {
      const evaluation = await db.Eval.findOne({ where: { publicId: evalId } });
      const abandoned = await db.EvalRun.create({
        evalId: evaluation!.id as number,
        agentVersion: 1,
        status: 'running',
        itemCount: 1,
        startedAt: new Date(),
      });

      const events = await withCapture({
        // Named, not counted: the reaper settles every stale run in the
        // database, so other runs' events can land in this window too.
        until: (captured) => {
          return captured.some((event) => {
            return event.resourceId === abandoned.publicId;
          });
        },
        action: async () => {
          await reapAbandonedEvalRuns({
            now: new Date(Date.now() + 86_400_000),
          });
        },
      });

      const failure = events.find((event) => {
        return event.resourceId === abandoned.publicId;
      });
      expect(failure?.type).toBe('eval_run.failed');
      expect(failure?.data).toEqual({
        eval_id: evalId,
        eval_run_id: abandoned.publicId,
        passed: null,
        aggregate_scores: null,
      });
    });

    test('a canceled run fires no lifecycle event — it produced no verdict', async () => {
      const events = await withCapture({
        action: async () => {
          const run = await asUser()
            .post(`/api/v1/evals/${evalId}/runs`)
            .send({ wait: false });
          await asUser().post(
            `/api/v1/evals/${evalId}/runs/${run.body.id}/cancel`
          );
        },
      });

      expect(events).toEqual([]);
    });
  });

  // ── Usage attribution (Phase 2) ──────────────────────────────────────────

  describe('eval spend attribution', () => {
    test("an eval run's generations are marked source: eval", async () => {
      const datasetId = (await createDataset('usage-suite')).id;
      await addItem(datasetId, { input: [{ role: 'user', content: 'a' }] });
      const usageEval = await createEval({
        name: 'usage-eval',
        agent_id: agentId,
        dataset_id: datasetId,
        scorers: [{ type: 'exact_match' }],
      });

      mockCreateGeneration.mockResolvedValueOnce(
        completedGeneration('gen_u1', 'Paris')
      );
      const res = await asUser()
        .post(`/api/v1/evals/${usageEval.id}/runs`)
        .send({ wait: true });
      expect(res.status).toBe(201);

      // Asserted on the generation the eval created, which is the column the
      // metering choke point copies onto the usage event: eval spend has to be
      // separable from the spend serving real users.
      const call = mockCreateGeneration.mock.calls[0][0];
      expect(call.source).toBe('eval');
      expect(call.stream).toBe(false);
    });
  });

  // ── Baseline deltas (Phase 2) ────────────────────────────────────────────

  describe('baseline deltas', () => {
    let evalId: string;
    let extraItemId: string;
    let datasetId: string;

    beforeAll(async () => {
      datasetId = (await createDataset('baseline-suite')).id;
      await addItem(datasetId, {
        input: [{ role: 'user', content: 'a' }],
        expected_output: 'Paris',
      });
      await addItem(datasetId, {
        input: [{ role: 'user', content: 'b' }],
        expected_output: 'Paris',
      });

      evalId = (
        await createEval({
          name: 'baseline-eval',
          agent_id: agentId,
          dataset_id: datasetId,
          scorers: [{ type: 'exact_match' }],
        })
      ).id;
    });

    /**
     * A synchronous run answering `answers[i]` for the i-th item.
     *
     * Exactly one queued generation per item: `jest.clearAllMocks()` clears call
     * counts but not queued `mockResolvedValueOnce` implementations, so an
     * over-queued mock would leak into the next run and silently shift its
     * scores.
     */
    const runWith = async (args: {
      answers: string[];
      baselineRunId?: string;
    }) => {
      const callsBefore = mockCreateGeneration.mock.calls.length;
      for (const [index, answer] of args.answers.entries()) {
        mockCreateGeneration.mockResolvedValueOnce(
          completedGeneration(`gen_bd${index}`, answer)
        );
      }

      const res = await asUser()
        .post(`/api/v1/evals/${evalId}/runs`)
        .send({
          wait: true,
          ...(args.baselineRunId === undefined
            ? {}
            : { baseline_run_id: args.baselineRunId }),
        });
      expect(res.status).toBe(201);
      // Relative to this call, since a test may start two runs and the shared
      // spy's counter is only cleared between tests.
      expect(mockCreateGeneration.mock.calls.length - callsBefore).toBe(
        args.answers.length
      );
      return res.body;
    };

    test('a run without a baseline reports no comparison', async () => {
      const run = await runWith({ answers: ['Paris', 'Paris'] });

      expect(run.aggregate_scores.baseline).toBeUndefined();
    });

    test('an improvement over the baseline reports positive deltas', async () => {
      const baseline = await runWith({ answers: ['Paris', 'Lyon'] });
      expect(baseline.aggregate_scores.pass_rate).toBeCloseTo(0.5);

      const current = await runWith({
        answers: ['Paris', 'Paris'],
        baselineRunId: baseline.id,
      });

      const comparison = current.aggregate_scores.baseline;
      expect(comparison.run_id).toBe(baseline.id);
      expect(comparison.compared_item_count).toBe(2);
      expect(comparison.added_item_count).toBe(0);
      expect(comparison.removed_item_count).toBe(0);
      expect(comparison.pass_rate_delta).toBeCloseTo(0.5);
      expect(comparison.scorers.exact_match.mean_delta).toBeCloseTo(0.5);
      expect(comparison.scorers.exact_match.pass_rate_delta).toBeCloseTo(0.5);
    });

    test('a regression reports negative deltas', async () => {
      const baseline = await runWith({ answers: ['Paris', 'Paris'] });
      const current = await runWith({
        answers: ['Lyon', 'Lyon'],
        baselineRunId: baseline.id,
      });

      expect(
        current.aggregate_scores.baseline.scorers.exact_match.mean_delta
      ).toBeCloseTo(-1);
    });

    // The guarantee that makes a delta trustworthy: an item added between the
    // two runs is counted, never averaged in, so dataset drift can't read as
    // agent regression.
    test('an item added since the baseline is counted, not averaged in', async () => {
      const baseline = await runWith({ answers: ['Paris', 'Paris'] });

      const added = await addItem(datasetId, {
        input: [{ role: 'user', content: 'c' }],
        expected_output: 'Paris',
      });
      extraItemId = added.id as string;

      // All three items answer correctly, so a naive comparison would also see
      // "no change" — the counts are what prove the intersection was used.
      const current = await runWith({
        answers: ['Paris', 'Paris', 'Paris'],
        baselineRunId: baseline.id,
      });

      const comparison = current.aggregate_scores.baseline;
      expect(comparison.compared_item_count).toBe(2);
      expect(comparison.added_item_count).toBe(1);
      expect(comparison.removed_item_count).toBe(0);
      expect(comparison.scorers.exact_match.mean_delta).toBe(0);

      await asUser().delete(
        `/api/v1/datasets/${datasetId}/items/${extraItemId}`
      );
    });

    test('a baseline from a different eval is rejected with 400', async () => {
      const otherEval = await createEval({
        name: 'baseline-other-eval',
        agent_id: agentId,
        dataset_id: datasetId,
        scorers: [{ type: 'exact_match' }],
      });
      const foreign = await runWith({ answers: ['Paris', 'Paris'] });

      const res = await asUser()
        .post(`/api/v1/evals/${otherEval.id}/runs`)
        .send({ wait: true, baseline_run_id: foreign.id });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/not a run of this eval/);
    });
  });

  // ── llm_judge end to end (Phase 2) ───────────────────────────────────────

  /**
   * The judge runs against a local OpenAI-compatible stub rather than a mock, so
   * the real `generateText` serialization, the provider resolution and the
   * verdict parsing all execute (`.claude/rules/tests.md` — prefer a local fake
   * server over a mock at an external boundary). Only the *agent's* generation
   * stays mocked, as everywhere else in this file.
   */
  describe('llm_judge runs', () => {
    let judgeServer: Server;
    let judgeProviderId: string;
    let judgePrompts: string[] = [];
    let judgeReply = '{"score": 0.9, "reasoning": "close enough"}';

    beforeAll(async () => {
      judgeServer = createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => {
          raw += chunk as string;
        });
        req.on('end', () => {
          const body = JSON.parse(raw) as {
            messages?: Array<{ content?: string }>;
          };
          judgePrompts.push(body.messages?.[0]?.content ?? '');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'chatcmpl-judge',
              object: 'chat.completion',
              created: 0,
              model: 'judge-model',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: judgeReply },
                  finish_reason: 'stop',
                },
              ],
              usage: {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
              },
            })
          );
        });
      });
      await new Promise<void>((resolve) => {
        judgeServer.listen(0, '127.0.0.1', resolve);
      });
      const { port } = judgeServer.address() as AddressInfo;

      const providerRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'Judge Provider',
          provider: 'ollama',
          default_model: 'judge-model',
          base_url: `http://127.0.0.1:${String(port)}/v1`,
        });
      expect(providerRes.status).toBe(201);
      judgeProviderId = providerRes.body.id;
    });

    afterAll(async () => {
      await new Promise<void>((resolve, reject) => {
        judgeServer.close((error) => {
          return error ? reject(error) : resolve();
        });
      });
    });

    beforeEach(() => {
      judgePrompts = [];
      judgeReply = '{"score": 0.9, "reasoning": "close enough"}';
    });

    /** An eval whose single scorer is a judge with the given threshold. */
    const judgeEval = async (args: { name: string; passThreshold: number }) => {
      const datasetId = (await createDataset(`${args.name}-suite`)).id;
      await addItem(datasetId, {
        input: [{ role: 'user', content: 'capital of France?' }],
        expected_output: 'Paris, France',
      });

      return createEval({
        name: args.name,
        agent_id: agentId,
        dataset_id: datasetId,
        scorers: [
          {
            type: 'llm_judge',
            ai_provider_id: judgeProviderId,
            model: 'judge-model',
            prompt:
              'Q: {{input}} A: {{output}} Ref: {{expected}}. Answer with JSON.',
            pass_threshold: args.passThreshold,
          },
        ],
      });
    };

    const runJudged = async (evalId: string) => {
      mockCreateGeneration.mockResolvedValueOnce(
        completedGeneration('gen_j1', 'Paris')
      );
      const res = await asUser()
        .post(`/api/v1/evals/${evalId}/runs`)
        .send({ wait: true });
      expect(res.status).toBe(201);

      const results = await asUser().get(
        `/api/v1/evals/${evalId}/runs/${res.body.id}/results`
      );
      return { run: res.body, result: results.body.data[0] };
    };

    test('renders every slot into the prompt the judge actually receives', async () => {
      const judged = await judgeEval({
        name: 'judge-render-eval',
        passThreshold: 0.7,
      });
      await runJudged(judged.id);

      expect(judgePrompts).toHaveLength(1);
      // Asserted at the wire, so this proves the real serialization — the agent
      // output, the item's input messages and the reference answer all arrive.
      expect(judgePrompts[0]).toContain('A: Paris');
      expect(judgePrompts[0]).toContain('Ref: Paris, France');
      expect(judgePrompts[0]).toContain('capital of France?');
      expect(judgePrompts[0]).not.toContain('{{output}}');
    });

    test('scores the item from the parsed verdict and stores the reasoning', async () => {
      const judged = await judgeEval({
        name: 'judge-score-eval',
        passThreshold: 0.7,
      });
      const { result } = await runJudged(judged.id);

      expect(result.scores).toEqual([
        {
          scorer: 'llm_judge',
          score: 0.9,
          passed: true,
          reasoning: 'close enough',
        },
      ]);
      expect(result.error).toBeNull();
    });

    test('per-item passed flips exactly at the threshold', async () => {
      const judged = await judgeEval({
        name: 'judge-threshold-eval',
        passThreshold: 0.9,
      });
      judgeReply = '{"score": 0.89}';

      const { result } = await runJudged(judged.id);

      expect(result.scores[0].score).toBeCloseTo(0.89);
      expect(result.scores[0].passed).toBe(false);
      expect(result.passed).toBe(false);
    });

    // A judge that cannot answer says nothing about the agent, so it must not
    // land as a score of 0 (a fabricated regression) nor fail the whole run.
    test('a malformed judge reply errors the item, not the run', async () => {
      const judged = await judgeEval({
        name: 'judge-malformed-eval',
        passThreshold: 0.7,
      });
      judgeReply = 'I think it was pretty good, honestly.';

      const { run, result } = await runJudged(judged.id);

      expect(run.status).toBe('completed');
      expect(run.errored_count).toBe(1);
      expect(run.completed_count).toBe(0);
      expect(result.error).toMatch(/did not answer with a JSON object/);
      expect(result.scores).toEqual([]);
      // Excluded from the aggregates rather than depressing them.
      expect(run.aggregate_scores.scored_item_count).toBe(0);
      expect(run.aggregate_scores.pass_rate).toBeNull();
      // The generation completed and produced an answer; only the scorer failed.
      // Keeping the output is what makes that failure debuggable — it is the one
      // thing you need to see to understand what the judge choked on.
      expect(result.output).toBe('Paris');
    });

    test('an out-of-range judge score errors the item rather than being clamped', async () => {
      const judged = await judgeEval({
        name: 'judge-range-eval',
        passThreshold: 0.7,
      });
      judgeReply = '{"score": 87}';

      const { run, result } = await runJudged(judged.id);

      expect(run.errored_count).toBe(1);
      expect(result.error).toMatch(/outside the 0–1 range/);
    });
  });

  // ── Worker internals (Phase 2) ───────────────────────────────────────────

  describe('worker settling and configuration', () => {
    let evalId: string;

    beforeAll(async () => {
      const datasetId = (await createDataset('worker-suite')).id;
      await addItem(datasetId, {
        input: [{ role: 'user', content: 'a' }],
        expected_output: 'Paris',
      });

      evalId = (
        await createEval({
          name: 'worker-eval',
          agent_id: agentId,
          dataset_id: datasetId,
          scorers: [{ type: 'exact_match' }],
        })
      ).id;
    });

    const startQueued = async () => {
      const res = await asUser()
        .post(`/api/v1/evals/${evalId}/runs`)
        .send({ wait: false });
      expect(res.status).toBe(201);
      return res.body;
    };

    // The at-least-once tail: a lease can expire after the run already settled.
    // The task must be dropped without spending another generation, and the
    // settled run must not be finalized (or announced) a second time.
    test('a task redelivered after the run settled is dropped, not re-run', async () => {
      const run = await startQueued();
      const runRow = await db.EvalRun.findOne({ where: { publicId: run.id } });
      const runDbId = runRow!.id as number;

      mockCreateGeneration.mockResolvedValueOnce(
        completedGeneration('gen_w1', 'Paris')
      );
      await drainEvalQueueOnce();
      expect(mockCreateGeneration).toHaveBeenCalledTimes(1);

      const settled = await db.EvalRun.findByPk(runDbId);
      expect(settled!.status).toBe('completed');
      const settledAt = settled!.finishedAt;

      const [result] = await db.EvalResult.findAll({
        where: { evalRunId: runDbId },
      });
      await db.EvalRunTask.create({
        evalRunId: runDbId,
        datasetItemId: result.datasetItemId as number,
        availableAt: new Date(),
        attempts: 2,
      });

      expect(await drainEvalQueueOnce()).toBe(1);

      // No second generation, and the terminal state is untouched.
      expect(mockCreateGeneration).toHaveBeenCalledTimes(1);
      await settled!.reload();
      expect(settled!.status).toBe('completed');
      expect(settled!.finishedAt).toEqual(settledAt);
      expect(await db.EvalResult.count({ where: { evalRunId: runDbId } })).toBe(
        1
      );
      // The task was still acked rather than left to redeliver forever.
      expect(
        await db.EvalRunTask.count({ where: { evalRunId: runDbId } })
      ).toBe(0);
    });

    // The guard that makes "exactly once per terminal run" a property of the
    // code: two workers racing a run's last item both see an empty queue.
    test('only the first caller wins the settle claim', async () => {
      const run = await startQueued();
      const runRow = await db.EvalRun.findOne({ where: { publicId: run.id } });

      mockCreateGeneration.mockResolvedValueOnce(
        completedGeneration('gen_w2', 'Paris')
      );
      await drainEvalQueueOnce();

      await runRow!.reload();
      const settleArgs = {
        run: runRow!,
        evalPublicId: evalId,
        projectId: (await db.Eval.findOne({ where: { publicId: evalId } }))!
          .projectId as number,
        passThreshold: null,
      };

      // The drain already settled it, so this stands in for the losing worker.
      expect(await finalizeIfUnclaimed(settleArgs)).toBe(false);
    });

    test('honours EVAL_WORKER_BATCH when claiming', async () => {
      process.env.EVAL_WORKER_BATCH = '1';
      try {
        await startQueued();
        mockCreateGeneration.mockResolvedValueOnce(
          completedGeneration('gen_w3', 'Paris')
        );
        expect(await drainEvalQueueOnce()).toBe(1);
      } finally {
        delete process.env.EVAL_WORKER_BATCH;
      }
    });

    test('falls back to the default batch when EVAL_WORKER_BATCH is not a number', async () => {
      process.env.EVAL_WORKER_BATCH = 'lots';
      try {
        await startQueued();
        mockCreateGeneration.mockResolvedValueOnce(
          completedGeneration('gen_w4', 'Paris')
        );
        expect(await drainEvalQueueOnce()).toBe(1);
      } finally {
        delete process.env.EVAL_WORKER_BATCH;
      }
    });

    test('honours EVAL_RUN_ABANDONED_AFTER_MS as the reaper grace period', async () => {
      const evaluation = await db.Eval.findOne({ where: { publicId: evalId } });
      const abandoned = await db.EvalRun.create({
        evalId: evaluation!.id as number,
        agentVersion: 1,
        status: 'running',
        itemCount: 1,
        startedAt: new Date(),
      });

      // A two-day grace period against a `now` one day out: under the
      // 30-minute default this run would be reaped, so it surviving is what
      // proves the configured value is the one the sweep read.
      process.env.EVAL_RUN_ABANDONED_AFTER_MS = String(2 * 86_400_000);
      try {
        expect(
          await reapAbandonedEvalRuns({
            now: new Date(Date.now() + 86_400_000),
          })
        ).toBe(0);
      } finally {
        delete process.env.EVAL_RUN_ABANDONED_AFTER_MS;
      }

      await abandoned.reload();
      expect(abandoned.status).toBe('running');
    });

    // A run whose `finished_at` is already set has been claimed by someone else,
    // so the reaper must leave it rather than settling it twice.
    test('the reaper skips a stale run whose settle claim is already taken', async () => {
      const evaluation = await db.Eval.findOne({ where: { publicId: evalId } });
      const claimed = await db.EvalRun.create({
        evalId: evaluation!.id as number,
        agentVersion: 1,
        status: 'running',
        itemCount: 1,
        startedAt: new Date(),
        finishedAt: new Date(),
      });

      await reapAbandonedEvalRuns({ now: new Date(Date.now() + 86_400_000) });

      await claimed.reload();
      expect(claimed.status).toBe('running');
    });

    test('kickEvalWorker drains when the worker is not disabled', async () => {
      await startQueued();
      mockCreateGeneration.mockResolvedValueOnce(
        completedGeneration('gen_w5', 'Paris')
      );

      delete process.env.EVAL_WORKER_DISABLED;
      try {
        kickEvalWorker();
        // The kick is fire-and-forget, so poll the observable side effect.
        for (let tick = 0; tick < 100; tick += 1) {
          if (mockCreateGeneration.mock.calls.length > 0) break;
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 10);
          });
        }
      } finally {
        process.env.EVAL_WORKER_DISABLED = 'true';
      }

      expect(mockCreateGeneration).toHaveBeenCalledTimes(1);
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
