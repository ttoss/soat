import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { db } from 'src/db';
import {
  createGenerationRecord,
  updateGenerationRecord,
} from 'src/lib/generations';

import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * Curating a real generation into a dataset item (#1003, first slice).
 *
 * The generation under test is a **real** one: the agent's AI provider points at
 * a local OpenAI-compatible stub, so the whole path runs — input messages are
 * persisted, the trace steps object is written, the turn completes. Mocking
 * `createGeneration` here would prove nothing, because what this route reads is
 * exactly what that path writes.
 */
describe('POST /api/v1/datasets/:dataset_id/items/from-generation', () => {
  let adminToken: string;
  let userToken: string;
  let noPermToken: string;
  let scopedToken: string;
  let projectId: string;
  let otherProjectId: string;
  let agentId: string;
  let clientToolAgentId: string;
  let zeroRetentionAgentId: string;
  let datasetId: string;
  let stubServer: Server;

  /** What the stub answers next. Reset to a plain completion after each test. */
  let stubResponse: Record<string, unknown>;

  const ASSISTANT_TEXT = 'Your invoice is issued on the first of each month.';
  const USER_QUESTION = 'When is my invoice issued?';

  const textCompletion = (content: string) => {
    return {
      id: 'chatcmpl-stub',
      object: 'chat.completion',
      created: 0,
      model: 'stub-model',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  };

  /** A completion that calls the client tool, so the turn pauses unfinished. */
  const toolCallCompletion = () => {
    return {
      id: 'chatcmpl-stub-tool',
      object: 'chat.completion',
      created: 0,
      model: 'stub-model',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_stub_1',
                type: 'function',
                function: {
                  name: 'get_weather',
                  arguments: '{"cityName":"Paris"}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  };

  const startStubServer = async (): Promise<string> => {
    stubServer = createServer((req, res) => {
      // Drained rather than parsed: what this stub answers is fixed per test by
      // `stubResponse`, and the outgoing request body is asserted elsewhere
      // (`memoryExtractionCompletion.test.ts`).
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stubResponse));
      });
    });

    await new Promise<void>((resolve) => {
      stubServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = stubServer.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  const asUser = () => {
    return authenticatedTestClient(userToken);
  };

  /** Runs a real generation to completion and returns its public id. */
  const runGeneration = async (args: {
    agentId?: string;
    content?: string;
  }): Promise<Record<string, unknown>> => {
    const res = await asUser()
      .post(`/api/v1/agents/${args.agentId ?? agentId}/generate?wait=true`)
      .send({
        messages: [{ role: 'user', content: args.content ?? USER_QUESTION }],
      });
    expect(res.status).toBe(200);
    return res.body;
  };

  const promote = async (
    body: Record<string, unknown>,
    token: string = userToken
  ) => {
    return authenticatedTestClient(token)
      .post(`/api/v1/datasets/${datasetId}/items/from-generation`)
      .send(body);
  };

  beforeAll(async () => {
    stubResponse = textCompletion(ASSISTANT_TEXT);
    const stubBaseUrl = await startStubServer();

    const setup = await setupProjectWithUsers({
      prefix: 'curation',
      policyActions: [
        'evaluations:CreateDataset',
        'evaluations:ListDatasets',
        'evaluations:GetDataset',
        'agents:CreateAgent',
        'agents:CreateAgentGeneration',
        'generations:GetGeneration',
        'generations:PurgeGenerationContent',
        'tools:CreateTool',
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
        name: 'Curation Provider',
        provider: 'ollama',
        default_model: 'stub-model',
        base_url: stubBaseUrl,
      });

    const agentRes = await asUser().post('/api/v1/agents').send({
      project_id: projectId,
      ai_provider_id: providerRes.body.id,
      name: 'Curation Agent',
      instructions: 'Answer billing questions.',
    });
    expect(agentRes.status).toBe(201);
    agentId = agentRes.body.id;

    // Zero-retention: the same provider, but this agent never stores content, so
    // its generations can never be promoted.
    const zeroRes = await asUser().post('/api/v1/agents').send({
      project_id: projectId,
      ai_provider_id: providerRes.body.id,
      name: 'Curation Zero Retention Agent',
      trace_content_mode: 'none',
    });
    expect(zeroRes.status).toBe(201);
    zeroRetentionAgentId = zeroRes.body.id;

    const toolRes = await asUser()
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'get_weather',
        type: 'client',
        description: 'Returns the weather for a city.',
        parameters: {
          type: 'object',
          properties: { cityName: { type: 'string' } },
          required: ['cityName'],
        },
      });
    expect(toolRes.status).toBe(201);

    const clientAgentRes = await asUser()
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: providerRes.body.id,
        name: 'Curation Client Tool Agent',
        tool_bindings: [{ tool_id: toolRes.body.id }],
        max_steps: 3,
      });
    expect(clientAgentRes.status).toBe(201);
    clientToolAgentId = clientAgentRes.body.id;

    const datasetRes = await asUser()
      .post('/api/v1/datasets')
      .send({ project_id: projectId, name: 'curated-from-production' });
    expect(datasetRes.status).toBe(201);
    datasetId = datasetRes.body.id;

    // Can create dataset items, but cannot read a generation — the pair the
    // route checks separately.
    scopedToken = await createScopedPrincipal({
      adminToken,
      projectId,
      username: 'curationnogen',
      actions: ['evaluations:CreateDataset', 'evaluations:GetDataset'],
    });
  });

  afterEach(() => {
    stubResponse = textCompletion(ASSISTANT_TEXT);
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      stubServer.close((err) => {
        return err ? reject(err) : resolve();
      });
    });
  });

  test('promotes a completed generation into a dataset item', async () => {
    const generation = await runGeneration({});

    const res = await promote({ generation_id: generation.id });

    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^dsit_/);
    expect(res.body.dataset_id).toBe(datasetId);
    // The caller's messages, exactly as the turn received them — the agent's
    // instructions are config, not input, and must not be replayed as a message.
    expect(res.body.input).toEqual([{ role: 'user', content: USER_QUESTION }]);
    // The turn's own answer becomes the reference the scorers compare against.
    expect(res.body.expected_output).toBe(ASSISTANT_TEXT);
    expect(res.body.source_generation_id).toBe(generation.id);
  });

  test('a caller-supplied expected_output and metadata override the derived ones', async () => {
    const generation = await runGeneration({});

    const res = await promote({
      generation_id: generation.id,
      expected_output: 'The first of the month.',
      metadata: { topic: 'billing' },
    });

    expect(res.status).toBe(201);
    expect(res.body.expected_output).toBe('The first of the month.');
    expect(res.body.metadata).toEqual({ topic: 'billing' });
    expect(res.body.source_generation_id).toBe(generation.id);
  });

  test('leaves expected_output null when the turn produced no text', async () => {
    // A turn can finish having said nothing (an empty completion, or a run that
    // only made tool calls). There is no reference answer to derive, and
    // inventing one — an empty string that every scorer would then compare
    // against — would be worse than recording its absence.
    stubResponse = textCompletion('');
    const generation = await runGeneration({});

    const res = await promote({ generation_id: generation.id });

    expect(res.status).toBe(201);
    expect(res.body.expected_output).toBeNull();
    expect(res.body.input).toEqual([{ role: 'user', content: USER_QUESTION }]);
  });

  test('promotes a turn whose steps object never landed, without a reference answer', async () => {
    // `saveTrace` is fire-and-forget on some paths, so a completed generation
    // can legitimately end up with its input recorded and no steps object to
    // derive an answer from. That is a fixture worth keeping — the caller can
    // still supply `expected_output` — not a reason to refuse the promotion.
    const project = await db.Project.findOne({
      where: { publicId: projectId },
    });
    const generationPublicId = `gen_nosteps_${Date.now()}`;
    const input = [{ role: 'user', content: 'Where did my steps go?' }];

    await createGenerationRecord({
      publicId: generationPublicId,
      projectId: project?.id as number,
      agentId,
      traceId: `trc_nosteps_${Date.now()}`,
      inputMessages: input,
    });
    await updateGenerationRecord({
      publicId: generationPublicId,
      status: 'completed',
      completedAt: new Date(),
    });

    const res = await promote({ generation_id: generationPublicId });

    expect(res.status).toBe(201);
    expect(res.body.input).toEqual(input);
    expect(res.body.expected_output).toBeNull();
    expect(res.body.source_generation_id).toBe(generationPublicId);
  });

  test('an explicit null expected_output is stored rather than derived', async () => {
    const generation = await runGeneration({});

    const res = await promote({
      generation_id: generation.id,
      expected_output: null,
    });

    expect(res.status).toBe(201);
    expect(res.body.expected_output).toBeNull();
  });

  test('the promoted item is listed in the dataset', async () => {
    const generation = await runGeneration({ content: 'Do I get a refund?' });
    const created = await promote({ generation_id: generation.id });
    expect(created.status).toBe(201);

    const list = await asUser().get(`/api/v1/datasets/${datasetId}/items`);

    expect(list.status).toBe(200);
    const found = (list.body.data as Array<Record<string, unknown>>).find(
      (item) => {
        return item.id === created.body.id;
      }
    );
    expect(found?.source_generation_id).toBe(generation.id);
  });

  test('returns 401 when unauthenticated', async () => {
    const res = await testClient
      .post(`/api/v1/datasets/${datasetId}/items/from-generation`)
      .send({ generation_id: 'gen_whatever' });

    expect(res.status).toBe(401);
  });

  test('returns 403 for a user without evaluations:CreateDataset', async () => {
    const generation = await runGeneration({});

    const res = await promote({ generation_id: generation.id }, noPermToken);

    expect(res.status).toBe(403);
  });

  test('returns 403 for a caller that may write items but may not read generations', async () => {
    const generation = await runGeneration({});

    const res = await promote({ generation_id: generation.id }, scopedToken);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  test('returns 400 when generation_id is missing', async () => {
    const res = await promote({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  test('returns 404 for a generation that does not exist', async () => {
    const res = await promote({ generation_id: 'gen_doesnotexist000000' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('GENERATION_NOT_FOUND');
  });

  test('returns 404 for a dataset that does not exist', async () => {
    const generation = await runGeneration({});

    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/datasets/dset_doesnotexist00000/items/from-generation')
      .send({ generation_id: generation.id });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
  });

  test('returns 409 for a generation that has not completed', async () => {
    stubResponse = toolCallCompletion();
    const paused = await asUser()
      .post(`/api/v1/agents/${clientToolAgentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'Weather in Paris?' }] });

    expect(paused.status).toBe(200);
    expect(paused.body.status).toBe('requires_action');

    const res = await promote({ generation_id: paused.body.id });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('GENERATION_NOT_COMPLETED');
  });

  test('returns 409 for a generation whose content was purged', async () => {
    const generation = await runGeneration({});

    const purge = await asUser().delete(
      `/api/v1/generations/${generation.id}/content`
    );
    expect(purge.status).toBe(200);

    const res = await promote({ generation_id: generation.id });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('GENERATION_CONTENT_UNAVAILABLE');
  });

  test('returns 409 for a zero-retention generation whose content was never stored', async () => {
    const generation = await runGeneration({ agentId: zeroRetentionAgentId });

    const res = await promote({ generation_id: generation.id });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('GENERATION_CONTENT_UNAVAILABLE');
  });

  test('cannot promote a generation from another project into this dataset', async () => {
    const otherProviderRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: otherProjectId,
        name: 'Other Curation Provider',
        provider: 'ollama',
        default_model: 'stub-model',
        base_url: `http://127.0.0.1:${
          (stubServer.address() as AddressInfo).port
        }`,
      });
    const otherAgentRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: otherProjectId,
        ai_provider_id: otherProviderRes.body.id,
        name: 'Other Curation Agent',
      });
    const otherGeneration = await authenticatedTestClient(adminToken)
      .post(`/api/v1/agents/${otherAgentRes.body.id}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'Cross-project?' }] });
    expect(otherGeneration.status).toBe(200);

    const res = await promote({ generation_id: otherGeneration.body.id });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});
