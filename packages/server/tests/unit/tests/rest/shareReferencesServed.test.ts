import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * A run reaches a shared resource through more than head definitions: the
 * agent version a release serves, the workflow version an open task is pinned
 * to, a guardrail's context tool and a tool's preset parameters.
 */
describe('Share references through served versions and attachments', () => {
  let adminToken: string;
  let publisherId: string;
  let granteeId: string;
  let granteeKey: string;
  let granteeProvider: string;

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

  const update = async (
    method: 'put' | 'patch',
    path: string,
    body: Record<string, unknown>
  ) => {
    const res = await admin()[method](path).send(body);
    expect(res.status).toBe(200);
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

  const sharedTool = async (name: string) => {
    const id = await createIn(publisherId, '/api/v1/tools', {
      name,
      type: 'http',
      parameters: { type: 'object', properties: {} },
      execute: { url: 'http://127.0.0.1:9/hook', method: 'POST' },
    });
    return { id, shareId: await shareAccepted({ type: 'tool', id }) };
  };

  const references = async (shareId: string) => {
    const res = await grantee().get(`/api/v1/shares/${shareId}/references`);
    expect(res.status).toBe(200);
    return res.body.data as Array<{ type: string; id: string }>;
  };

  /** An agent whose version 1 binds `toolId` and whose version 2 does not. */
  const agentThatDroppedTool = async (toolId: string) => {
    const agent = await createIn(granteeId, '/api/v1/agents', {
      name: 'Dropped the tool',
      ai_provider_id: granteeProvider,
      tool_bindings: [{ tool_id: toolId }],
    });
    await update('put', `/api/v1/agents/${agent}`, { tool_bindings: [] });
    return agent;
  };

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'shareservedadmin', password: 'supersecret' });
    adminToken = await loginAs('shareservedadmin', 'supersecret');

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
    granteeProvider = await createIn(granteeId, '/api/v1/ai-providers', {
      name: 'Grantee provider',
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: 'http://127.0.0.1:9',
    });
  });

  test('lists an agent whose release serves a version binding the shared tool', async () => {
    const tool = await sharedTool('servedByRelease');
    const released = await agentThatDroppedTool(tool.id);
    await agentThatDroppedTool(tool.id);
    const release = await admin()
      .put(`/api/v1/agents/${released}/release`)
      .send({ stable_version: 1, canary_version: 2, canary_percent: 10 });
    expect(release.status).toBe(200);

    expect(await references(tool.shareId)).toEqual([
      { type: 'agent', id: released },
    ]);
  });

  test('lists a workflow an open task runs on a version dispatching a reaching agent', async () => {
    const tool = await sharedTool('dispatchedByPinnedVersion');
    const agent = await createIn(granteeId, '/api/v1/agents', {
      name: 'Binds the tool',
      ai_provider_id: granteeProvider,
      tool_bindings: [{ tool_id: tool.id }],
    });
    const states = (dispatch: boolean) => {
      return [
        { name: 'todo', initial: true, kind: 'human' },
        dispatch
          ? {
              name: 'working',
              on_enter: { dispatch: { kind: 'agent', agent_id: agent } },
            }
          : { name: 'working', kind: 'human' },
        { name: 'done', terminal: true },
      ];
    };
    const transitions = [
      { name: 'start', from: ['todo'], to: 'working' },
      { name: 'finish', from: ['working'], to: 'done' },
    ];
    const workflow = async (name: string) => {
      return createIn(granteeId, '/api/v1/workflows', {
        name,
        states: states(true),
        transitions,
      });
    };
    const pinned = await workflow('pinned-by-a-task');
    const unpinned = await workflow('no-open-task');
    const task = await admin()
      .post('/api/v1/tasks')
      .send({ project_id: granteeId, workflow_id: pinned, title: 'pinned' });
    expect(task.status).toBe(201);
    for (const id of [pinned, unpinned]) {
      await update('patch', `/api/v1/workflows/${id}`, {
        states: states(false),
        transitions,
      });
    }

    expect(await references(tool.shareId)).toEqual([
      { type: 'agent', id: agent },
      { type: 'workflow', id: pinned },
    ]);
  });

  test('lists a guardrail whose context tool reaches the shared tool, and what attaches it', async () => {
    const tool = await sharedTool('fetchedAsContext');
    const pipeline = await createIn(granteeId, '/api/v1/tools', {
      name: 'wrapsContextTool',
      type: 'pipeline',
      parameters: { type: 'object', properties: {} },
      pipeline: { steps: [{ id: 'call', tool_id: tool.id }] },
    });
    const guardrail = await createIn(granteeId, '/api/v1/guardrails', {
      name: 'Reads context',
      document: { class: 'A' },
      context_tool_id: pipeline,
    });
    const agent = await createIn(granteeId, '/api/v1/agents', {
      name: 'Guarded',
      ai_provider_id: granteeProvider,
      guardrail_ids: [guardrail],
    });
    const guardedTool = await createIn(granteeId, '/api/v1/tools', {
      name: 'guardedTool',
      type: 'http',
      parameters: { type: 'object', properties: {} },
      execute: { url: 'http://127.0.0.1:9/hook', method: 'POST' },
      guardrail_ids: [guardrail],
    });

    expect(await references(tool.shareId)).toEqual([
      { type: 'agent', id: agent },
      { type: 'tool', id: pipeline },
      { type: 'tool', id: guardedTool },
      { type: 'guardrail', id: guardrail },
    ]);
  });

  test('lists a tool whose preset parameters name the shared agent', async () => {
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
    const sharedAgent = await createIn(publisherId, '/api/v1/agents', {
      name: 'Preset target',
      ai_provider_id: publisherProvider,
    });
    const shareId = await shareAccepted({ type: 'agent', id: sharedAgent });
    const tool = await createIn(granteeId, '/api/v1/tools', {
      name: 'asks',
      type: 'builtin',
      actions: ['create-agent-generation'],
      preset_parameters: { agent_id: sharedAgent },
    });

    expect(await references(shareId)).toEqual([{ type: 'tool', id: tool }]);
  });
});
