import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * A grantee resource reaches a shared one through its own agents and tools:
 * `GET /shares/{id}/references` lists every resource a run can reach the
 * shared resource from, not only those naming it directly.
 */
describe('Share references through local resources', () => {
  let adminToken: string;
  let publisherId: string;
  let granteeId: string;
  let granteeKey: string;

  const admin = () => {
    return authenticatedTestClient(adminToken);
  };

  const grantee = () => {
    return authenticatedTestClient(granteeKey);
  };

  const createIn = async (
    projectId: string,
    path: string,
    body: Record<string, unknown>
  ) => {
    const res = await admin()
      .post(path)
      .send({ project_id: projectId, ...body });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const shareAccepted = async (args: {
    type: 'tool' | 'agent';
    id: string;
  }) => {
    const share = await admin()
      .post('/api/v1/shares')
      .send({
        project_id: publisherId,
        resource: `srn:${publisherId}:${args.type}:${args.id}`,
        actions: [
          args.type === 'tool'
            ? 'tools:CallTool'
            : 'agents:CreateAgentGeneration',
        ],
        grantee: granteeId,
      });
    expect(share.status).toBe(201);
    const accepted = await grantee().post(
      `/api/v1/shares/${share.body.id}/accept`
    );
    expect(accepted.status).toBe(200);
    return share.body.id as string;
  };

  const references = async (shareId: string) => {
    const res = await grantee().get(`/api/v1/shares/${shareId}/references`);
    expect(res.status).toBe(200);
    return res.body.data as Array<{ type: string; id: string }>;
  };

  let granteeProvider: string;
  let toolShareId: string;
  let agentShareId: string;
  let sharedAgentId: string;
  let chain: Array<{ type: string; id: string }>;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'sharereachadmin', password: 'supersecret' });
    adminToken = await loginAs('sharereachadmin', 'supersecret');

    publisherId = (
      await admin().post('/api/v1/projects').send({ name: 'Publisher' })
    ).body.id;
    granteeId = (
      await admin().post('/api/v1/projects').send({ name: 'Grantee' })
    ).body.id;
    granteeKey = (
      await admin()
        .post('/api/v1/api-keys')
        .send({ name: 'Grantee key', project_id: granteeId })
    ).body.key;

    const sharedTool = await createIn(publisherId, '/api/v1/tools', {
      name: 'reachedTool',
      type: 'http',
      parameters: { type: 'object', properties: {} },
      execute: { url: 'http://127.0.0.1:9/hook', method: 'POST' },
    });
    toolShareId = await shareAccepted({ type: 'tool', id: sharedTool });
    const publisherProvider = await createIn(
      publisherId,
      '/api/v1/ai-providers',
      {
        name: 'Publisher provider',
        provider: 'ollama',
        default_model: 'stub-model',
        base_url: 'http://127.0.0.1:9',
      }
    );
    sharedAgentId = await createIn(publisherId, '/api/v1/agents', {
      name: 'Reached agent',
      ai_provider_id: publisherProvider,
    });
    agentShareId = await shareAccepted({ type: 'agent', id: sharedAgentId });

    granteeProvider = await createIn(granteeId, '/api/v1/ai-providers', {
      name: 'Grantee provider',
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: 'http://127.0.0.1:9',
    });
    const pipeline = await createIn(granteeId, '/api/v1/tools', {
      name: 'wrapsSharedTool',
      type: 'pipeline',
      parameters: { type: 'object', properties: {} },
      pipeline: { steps: [{ id: 'call', tool_id: sharedTool }] },
    });
    const agent = await createIn(granteeId, '/api/v1/agents', {
      name: 'Binds the wrapper',
      ai_provider_id: granteeProvider,
      tool_bindings: [{ tool_id: pipeline }],
    });
    const orchestration = await createIn(granteeId, '/api/v1/orchestrations', {
      name: 'Asks the local agent',
      nodes: [{ id: 'ask', type: 'agent', agent_id: agent }],
      edges: [],
    });
    const trigger = await createIn(granteeId, '/api/v1/triggers', {
      name: 'fires-the-orchestration',
      type: 'manual',
      target_type: 'orchestration',
      target_id: orchestration,
    });
    const workflow = await createIn(granteeId, '/api/v1/workflows', {
      name: 'dispatches-the-agent',
      states: [
        { name: 'todo', initial: true, kind: 'human' },
        {
          name: 'working',
          on_enter: { dispatch: { kind: 'agent', agent_id: agent } },
        },
        { name: 'done', terminal: true },
      ],
      transitions: [
        { name: 'start', from: ['todo'], to: 'working' },
        { name: 'finish', from: ['working'], to: 'done' },
      ],
    });
    const playbook = await createIn(granteeId, '/api/v1/playbooks', {
      name: 'runs-the-orchestration',
      definition: {
        nodes: [
          {
            id: 'run',
            title: 'Run',
            kind: 'execute',
            final: true,
            inputs: [],
            executor: { type: 'orchestration', id: orchestration },
          },
        ],
      },
    });
    const dataset = await createIn(granteeId, '/api/v1/datasets', {
      name: 'reach-dataset',
    });
    const evaluation = await createIn(granteeId, '/api/v1/evals', {
      name: 'evaluates-the-agent',
      agent_id: agent,
      dataset_id: dataset,
      scorers: [{ type: 'exact_match' }],
    });
    const decider = await createIn(granteeId, '/api/v1/deciders', {
      name: 'asks-the-agent',
      agent_id: agent,
      questions: [
        { type: 'predicate', name: 'escalate', instructions: 'Escalate?' },
      ],
    });
    chain = [
      { type: 'agent', id: agent },
      { type: 'tool', id: pipeline },
      { type: 'decider', id: decider },
      { type: 'orchestration', id: orchestration },
      { type: 'workflow', id: workflow },
      { type: 'playbook', id: playbook },
      { type: 'eval', id: evaluation },
      { type: 'trigger', id: trigger },
    ];
  });

  test('lists every resource reaching the shared tool through local ones', async () => {
    expect(await references(toolShareId)).toEqual(chain);
  });

  test('lists a playbook naming a shared agent', async () => {
    const playbook = await createIn(granteeId, '/api/v1/playbooks', {
      name: 'asks-the-shared-agent',
      definition: {
        nodes: [
          {
            id: 'ask',
            title: 'Ask',
            kind: 'execute',
            final: true,
            inputs: [],
            executor: { type: 'agent', id: sharedAgentId },
          },
        ],
      },
    });

    expect(await references(agentShareId)).toEqual([
      { type: 'playbook', id: playbook },
    ]);
  });

  test('the revoke refusal lists what reaches the resource', async () => {
    const response = await grantee().post(
      `/api/v1/shares/${toolShareId}/revoke`
    );

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('SHARE_IN_USE');
    expect(response.body.error.meta.references).toEqual(chain);
  });

  test('a local resource is listed once however many paths reach it', async () => {
    const tool = await createIn(publisherId, '/api/v1/tools', {
      name: 'twiceReachedTool',
      type: 'http',
      parameters: { type: 'object', properties: {} },
      execute: { url: 'http://127.0.0.1:9/hook', method: 'POST' },
    });
    const shareId = await shareAccepted({ type: 'tool', id: tool });
    const agent = await createIn(granteeId, '/api/v1/agents', {
      name: 'Binds it directly',
      ai_provider_id: granteeProvider,
      tool_bindings: [{ tool_id: tool }],
    });
    const orchestration = await createIn(granteeId, '/api/v1/orchestrations', {
      name: 'Calls it and the agent',
      nodes: [
        { id: 'call', type: 'tool', tool_id: tool },
        { id: 'ask', type: 'agent', agent_id: agent },
      ],
      edges: [{ from: 'call', to: 'ask' }],
    });

    expect(await references(shareId)).toEqual([
      { type: 'agent', id: agent },
      { type: 'orchestration', id: orchestration },
    ]);
  });
});
