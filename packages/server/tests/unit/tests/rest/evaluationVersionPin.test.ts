import {
  type ChatCompletionsStub,
  startChatCompletionsStub,
  systemText,
  textCompletion,
} from '../../fixtures/chatCompletionsStub';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * The version an eval run pins is the config its generations actually run —
 * asserted on the instructions the provider receives, since the run record's
 * `agent_version` alone would agree with a pin that never reached config
 * resolution.
 */
describe('POST /api/v1/evals/:eval_id/runs — agent version pinning', () => {
  let stub: ChatCompletionsStub;
  let adminToken: string;
  let evalId: string;

  const V1_INSTRUCTIONS = 'Answer in one word.';
  const V2_INSTRUCTIONS = 'Answer in full sentences.';

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const run = async (agentVersion?: number) => {
    stub.completions.length = 0;
    const res = await asAdmin()
      .post(`/api/v1/evals/${evalId}/runs`)
      .send({
        wait: true,
        ...(agentVersion === undefined ? {} : { agent_version: agentVersion }),
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('completed');
    expect(stub.completions).toHaveLength(1);
    return { run: res.body, served: systemText(stub.completions[0]) };
  };

  beforeAll(async () => {
    stub = await startChatCompletionsStub();
    stub.reply(textCompletion('Paris'));

    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'evalpinadmin', password: 'supersecret' });
    adminToken = await loginAs('evalpinadmin', 'supersecret');

    const project = await asAdmin()
      .post('/api/v1/projects')
      .send({ name: 'Eval Pinning Project' });
    const projectId = project.body.id;

    const provider = await asAdmin().post('/api/v1/ai-providers').send({
      project_id: projectId,
      name: 'Eval Pinning Provider',
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: stub.baseUrl,
    });

    const agent = await asAdmin().post('/api/v1/agents').send({
      project_id: projectId,
      ai_provider_id: provider.body.id,
      name: 'Eval Pinning Agent',
      instructions: V1_INSTRUCTIONS,
    });
    expect(agent.status).toBe(201);

    // A second version, so the live row and the archive genuinely differ.
    const updated = await asAdmin()
      .patch(`/api/v1/agents/${agent.body.id}`)
      .send({ instructions: V2_INSTRUCTIONS });
    expect(updated.body.version).toBe(2);

    const dataset = await asAdmin()
      .post('/api/v1/datasets')
      .send({ project_id: projectId, name: 'eval-pinning-suite' });
    const item = await asAdmin()
      .post(`/api/v1/datasets/${dataset.body.id}/items`)
      .send({
        input: [{ role: 'user', content: 'Capital of France?' }],
        expected_output: 'Paris',
      });
    expect(item.status).toBe(201);

    const evaluation = await asAdmin()
      .post('/api/v1/evals')
      .send({
        project_id: projectId,
        name: 'eval-pinning',
        agent_id: agent.body.id,
        dataset_id: dataset.body.id,
        scorers: [{ type: 'exact_match' }],
      });
    expect(evaluation.status).toBe(201);
    evalId = evaluation.body.id;
  });

  afterAll(async () => {
    await stub.close();
  });

  test('with no agent_version the live config is served', async () => {
    const { run: evalRun, served } = await run();

    expect(evalRun.agent_version).toBe(2);
    expect(served).toContain(V2_INSTRUCTIONS);
  });

  test('an archived agent_version serves that version’s config', async () => {
    const { run: evalRun, served } = await run(1);

    expect(evalRun.agent_version).toBe(1);
    expect(served).toContain(V1_INSTRUCTIONS);
    expect(served).not.toContain(V2_INSTRUCTIONS);
  });

  test('pinning the live version serves the live config', async () => {
    const { run: evalRun, served } = await run(2);

    expect(evalRun.agent_version).toBe(2);
    expect(served).toContain(V2_INSTRUCTIONS);
  });
});
