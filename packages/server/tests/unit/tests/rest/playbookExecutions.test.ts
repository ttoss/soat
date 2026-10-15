import { pollUntil } from '../../fixtures/agentToolTurn';
import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import {
  type ChatCompletionsStub,
  startChatCompletionsStub,
  textCompletion,
  toolCallCompletion,
} from '../../fixtures/chatCompletionsStub';
import { authenticatedTestClient, testClient } from '../../testClient';

const CASE_ACTIONS = [
  'playbooks:CreatePlaybook',
  'playbooks:CreatePlaybookCase',
  'playbooks:GetPlaybookCase',
  'playbooks:WritePlaybookCaseInputs',
  'playbooks:RunPlaybookCaseNode',
  'playbooks:ListPlaybookCaseExecutions',
  'playbooks:GetPlaybookCaseExecution',
];

const DECIDER_ANSWER = {
  answers: [{ type: 'predicate', name: 'escalate', probability: 0.9 }],
};

/** A manual `amount` and a node that reads it through `executor`. */
const readsAmount = (executor: Record<string, unknown>) => {
  return {
    nodes: [
      {
        key: 'revenue',
        title: 'Revenue',
        kind: 'collect',
        inputs: [
          {
            name: 'amount',
            schema: { type: 'number' },
            required: true,
            source: 'manual',
          },
        ],
      },
      {
        key: 'pricing',
        title: 'Pricing',
        kind: 'execute',
        final: true,
        inputs: [
          {
            name: 'amount',
            schema: { type: 'number' },
            required: true,
            source: { node: 'revenue', field: 'output.amount' },
          },
        ],
        executor,
      },
    ],
  };
};

/** One `execute` node reading a manual `amount` itself. */
const runsOnAmount = (executor: Record<string, unknown>) => {
  return {
    nodes: [
      {
        key: 'pricing',
        title: 'Pricing',
        kind: 'execute',
        inputs: [
          {
            name: 'amount',
            schema: { type: 'number' },
            required: true,
            source: 'manual',
          },
        ],
        executor,
      },
    ],
  };
};

describe('Playbook executions', () => {
  let stub: ChatCompletionsStub;
  let adminToken: string;
  let userToken: string;
  let noPermToken: string;
  let projectId: string;
  let doubleToolId: string;
  let constantToolId: string;
  let failingToolId: string;
  let agentId: string;
  let deciderId: string;
  let workflowId: string;
  let orchestrationId: string;
  let failingOrchestrationId: string;
  let humanOrchestrationId: string;
  let misdeciderId: string;
  let clientToolAgentId: string;
  let seq = 0;

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const create = async (path: string, body: Record<string, unknown>) => {
    const res = await asAdmin()
      .post(path)
      .send({ project_id: projectId, ...body });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  /** A case on a fresh playbook, written by `token` (the author). */
  const newCase = async (args: {
    definition: object;
    token?: string;
  }): Promise<string> => {
    seq += 1;
    const token = args.token ?? adminToken;
    const playbook = await authenticatedTestClient(token)
      .post('/api/v1/playbooks')
      .send({
        project_id: projectId,
        name: `exec-${seq}`,
        definition: args.definition,
      });
    expect(playbook.status).toBe(201);
    const created = await asAdmin()
      .post(`/api/v1/playbooks/${playbook.body.id}/cases`)
      .send({ subject: `client-${seq}` });
    expect(created.status).toBe(201);
    return created.body.id as string;
  };

  const write = async (
    caseId: string,
    inputs: Array<{ node: string; name: string; value: unknown }>
  ) => {
    const current = await asAdmin().get(`/api/v1/playbook-cases/${caseId}`);
    const revisionOf = (node: string, name: string) => {
      const found = current.body.nodes.find((each: { key: string }) => {
        return each.key === node;
      });
      return found.inputs.find((each: { name: string }) => {
        return each.name === name;
      }).revision;
    };
    const res = await asAdmin()
      .post(`/api/v1/playbook-cases/${caseId}/inputs`)
      .send({
        inputs: inputs.map((input) => {
          return {
            ...input,
            expected_revision: revisionOf(input.node, input.name),
          };
        }),
      });
    expect(res.status).toBe(200);
  };

  const run = (
    caseId: string,
    node: string,
    body: Record<string, unknown> = { wait: true },
    token = userToken
  ) => {
    return authenticatedTestClient(token)
      .post(`/api/v1/playbook-cases/${caseId}/nodes/${node}/run`)
      .send(body);
  };

  const nodeOf = async (caseId: string, key: string) => {
    const res = await asAdmin().get(`/api/v1/playbook-cases/${caseId}`);
    return res.body.nodes.find((node: { key: string }) => {
      return node.key === key;
    });
  };

  const settled = async (caseId: string, executionId: string) => {
    const execution = await pollUntil({
      read: async () => {
        const res = await asAdmin().get(
          `/api/v1/playbook-cases/${caseId}/executions/${executionId}`
        );
        return res.body;
      },
      done: (body) => {
        return body.status !== 'running';
      },
    });
    expect(execution.status).not.toBe('running');
    return execution;
  };

  beforeAll(async () => {
    stub = await startChatCompletionsStub({
      routes: {
        '/double': (request) => {
          return { body: { doubled: Number(request.body.value) * 2 } };
        },
        '/constant': () => {
          return { body: { ok: true } };
        },
        '/fail': () => {
          return { status: 500, body: { message: 'down' } };
        },
        '/decide': () => {
          return { body: DECIDER_ANSWER };
        },
        '/misdecide': () => {
          return { body: { answers: [] } };
        },
      },
    });

    const setup = await setupProjectWithUsers({
      prefix: 'playbookexec',
      policyActions: CASE_ACTIONS,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    noPermToken = setup.noPermToken!;
    projectId = setup.projectId;

    const httpTool = (path: string) => {
      return create('/api/v1/tools', {
        name: `tool${path.replace('/', '-')}`,
        type: 'http',
        description: 'A tool the stub answers',
        parameters: { type: 'object', properties: {} },
        execute: { url: `${stub.baseUrl}${path}`, method: 'POST' },
      });
    };
    doubleToolId = await httpTool('/double');
    constantToolId = await httpTool('/constant');
    failingToolId = await httpTool('/fail');

    const providerId = await create('/api/v1/ai-providers', {
      name: 'exec-provider',
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: stub.baseUrl,
    });
    agentId = await create('/api/v1/agents', {
      ai_provider_id: providerId,
      name: 'exec-agent',
    });
    deciderId = await create('/api/v1/deciders', {
      name: 'exec-decider',
      tool_id: await httpTool('/decide'),
      questions: [
        { type: 'predicate', name: 'escalate', instructions: 'Escalate?' },
      ],
    });
    workflowId = await create('/api/v1/workflows', {
      name: 'exec-review',
      states: [
        { name: 'open', initial: true },
        { name: 'done', terminal: true },
      ],
      transitions: [{ name: 'finish', from: ['open'], to: 'done' }],
    });
    orchestrationId = await create('/api/v1/orchestrations', {
      name: 'exec-orchestration',
      nodes: [{ id: 'start', type: 'transform', expression: 'done' }],
      edges: [],
    });
    failingOrchestrationId = await create('/api/v1/orchestrations', {
      name: 'exec-failing-orchestration',
      nodes: [{ id: 'call', type: 'tool', tool_id: failingToolId }],
      edges: [],
    });
    humanOrchestrationId = await create('/api/v1/orchestrations', {
      name: 'exec-human-orchestration',
      nodes: [{ id: 'ask', type: 'human', prompt: 'Approve?' }],
      edges: [],
    });
    misdeciderId = await create('/api/v1/deciders', {
      name: 'exec-misdecider',
      tool_id: await httpTool('/misdecide'),
      questions: [
        { type: 'predicate', name: 'escalate', instructions: 'Escalate?' },
      ],
    });
    const clientToolId = await create('/api/v1/tools', {
      name: 'confirm',
      type: 'client',
      description: 'Asks the caller to confirm.',
      parameters: { type: 'object', properties: {} },
    });
    clientToolAgentId = await create('/api/v1/agents', {
      ai_provider_id: providerId,
      name: 'exec-client-tool-agent',
      tool_bindings: [{ tool_id: clientToolId }],
    });
  });

  afterAll(async () => {
    await stub.close();
  });

  describe('POST /api/v1/playbook-cases/{case_id}/nodes/{node}/run', () => {
    test('a collect node takes its inputs as its output', async () => {
      const caseId = await newCase({
        definition: readsAmount({
          type: 'tool',
          id: doubleToolId,
          input: { value: { var: 'amount' } },
        }),
      });
      await write(caseId, [{ node: 'revenue', name: 'amount', value: 10 }]);

      const res = await run(caseId, 'revenue');

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        id: expect.stringMatching(/^pbk_exe_/),
        case_id: caseId,
        node: 'revenue',
        executor: null,
        status: 'succeeded',
        result: 'current',
        output: { amount: 10 },
        output_revision: 2,
      });
      expect(await nodeOf(caseId, 'revenue')).toMatchObject({
        state: 'done',
        output: { value: { amount: 10 }, revision: 2 },
      });
      expect((await nodeOf(caseId, 'pricing')).state).toBe('ready');
    });

    test('a tool node calls the tool with its mapped input', async () => {
      const caseId = await newCase({
        definition: readsAmount({
          type: 'tool',
          id: doubleToolId,
          input: { value: { var: 'amount' } },
        }),
      });
      await write(caseId, [{ node: 'revenue', name: 'amount', value: 21 }]);
      await run(caseId, 'revenue');

      const res = await run(caseId, 'pricing');

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        executor: { type: 'tool', id: doubleToolId },
        status: 'succeeded',
        input: { value: 21 },
        output: { doubled: 42 },
      });
      expect((await nodeOf(caseId, 'pricing')).state).toBe('done');
    });

    test('an output equal to the current one writes no revision', async () => {
      const caseId = await newCase({
        definition: runsOnAmount({ type: 'tool', id: constantToolId }),
      });
      await write(caseId, [{ node: 'pricing', name: 'amount', value: 1 }]);
      const first = await run(caseId, 'pricing');
      expect(first.body.output_revision).toBe(2);
      await write(caseId, [{ node: 'pricing', name: 'amount', value: 2 }]);
      expect((await nodeOf(caseId, 'pricing')).state).toBe('stale');

      const res = await run(caseId, 'pricing');

      expect(res.body.output).toEqual({ ok: true });
      expect(res.body.output_revision).toBeNull();
      expect(await nodeOf(caseId, 'pricing')).toMatchObject({
        state: 'done',
        output: { revision: 2 },
      });
    });

    test('a failed executor fails the node, which can run again', async () => {
      const caseId = await newCase({
        definition: runsOnAmount({ type: 'tool', id: failingToolId }),
      });
      await write(caseId, [{ node: 'pricing', name: 'amount', value: 1 }]);

      const res = await run(caseId, 'pricing');

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('failed');
      expect(res.body.error).toEqual(
        expect.objectContaining({ code: expect.any(String) })
      );
      expect((await nodeOf(caseId, 'pricing')).state).toBe('failed');
      expect((await run(caseId, 'pricing')).status).toBe(201);
    });

    test('without wait it answers running and settles in the background', async () => {
      const caseId = await newCase({
        definition: runsOnAmount({ type: 'tool', id: constantToolId }),
      });
      await write(caseId, [{ node: 'pricing', name: 'amount', value: 1 }]);

      const res = await run(caseId, 'pricing', {});

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('running');
      expect((await settled(caseId, res.body.id)).output).toEqual({
        ok: true,
      });
    });

    test('an agent node answers with its text', async () => {
      stub.reply(textCompletion('Simples Nacional'));
      const caseId = await newCase({
        definition: runsOnAmount({ type: 'agent', id: agentId }),
      });
      await write(caseId, [{ node: 'pricing', name: 'amount', value: 1 }]);

      const res = await run(caseId, 'pricing');

      expect(res.body).toMatchObject({
        status: 'succeeded',
        output: 'Simples Nacional',
        run_id: expect.stringMatching(/^gen_/),
      });
    });

    test('a decider node answers with its answers by name', async () => {
      const caseId = await newCase({
        definition: runsOnAmount({ type: 'decider', id: deciderId }),
      });
      await write(caseId, [{ node: 'pricing', name: 'amount', value: 1 }]);

      const res = await run(caseId, 'pricing');

      expect(res.body.status).toBe('succeeded');
      expect(res.body.output.escalate).toMatchObject({ probability: 0.9 });
      expect(res.body.run_id).toMatch(/^dec/);
    });

    test('an orchestration node answers with its run output', async () => {
      const caseId = await newCase({
        definition: runsOnAmount({
          type: 'orchestration',
          id: orchestrationId,
        }),
      });
      await write(caseId, [{ node: 'pricing', name: 'amount', value: 1 }]);

      const res = await run(caseId, 'pricing');

      expect(res.body.status).toBe('succeeded');
      expect(res.body.run_id).toEqual(expect.any(String));
      expect((await nodeOf(caseId, 'pricing')).state).toBe('done');
    });

    test('an agent that stops for a client tool fails the node', async () => {
      stub.reply(toolCallCompletion([{ id: 'call_confirm', name: 'confirm' }]));
      const caseId = await newCase({
        definition: runsOnAmount({ type: 'agent', id: clientToolAgentId }),
      });
      await write(caseId, [{ node: 'pricing', name: 'amount', value: 1 }]);

      const res = await run(caseId, 'pricing');

      expect(res.body.status).toBe('failed');
      expect(res.body.error.code).toBe('PLAYBOOK_EXECUTION_FAILED');
    });

    test('a failed decision fails the node', async () => {
      const caseId = await newCase({
        definition: runsOnAmount({ type: 'decider', id: misdeciderId }),
      });
      await write(caseId, [{ node: 'pricing', name: 'amount', value: 1 }]);

      const res = await run(caseId, 'pricing');

      expect(res.body.status).toBe('failed');
      expect((await nodeOf(caseId, 'pricing')).state).toBe('failed');
    });

    test('a failed orchestration run fails the node', async () => {
      const caseId = await newCase({
        definition: runsOnAmount({
          type: 'orchestration',
          id: failingOrchestrationId,
        }),
      });
      await write(caseId, [{ node: 'pricing', name: 'amount', value: 1 }]);

      const res = await run(caseId, 'pricing');

      expect(res.body.status).toBe('failed');
      expect(res.body.error.code).toBe('PLAYBOOK_EXECUTION_FAILED');
    });

    test('an orchestration run parked on a person settles when it ends', async () => {
      const caseId = await newCase({
        definition: runsOnAmount({
          type: 'orchestration',
          id: humanOrchestrationId,
        }),
      });
      await write(caseId, [{ node: 'pricing', name: 'amount', value: 1 }]);

      const res = await run(caseId, 'pricing');
      expect(res.body.status).toBe('running');

      const answered = await asAdmin()
        .post(`/api/v1/orchestration-runs/${res.body.run_id}/human-input`)
        .send({ node_id: 'ask', output: { approved: true } });
      expect(answered.body.status).toBe('succeeded');

      expect((await settled(caseId, res.body.id)).status).toBe('succeeded');
      expect((await nodeOf(caseId, 'pricing')).state).toBe('done');
    });

    test('a workflow node settles when its task closes', async () => {
      const caseId = await newCase({
        definition: runsOnAmount({ type: 'workflow', id: workflowId }),
      });
      await write(caseId, [{ node: 'pricing', name: 'amount', value: 7 }]);

      const res = await run(caseId, 'pricing');
      expect(res.body.status).toBe('running');
      expect(res.body.run_id).toMatch(/^task_/);
      expect((await nodeOf(caseId, 'pricing')).state).toBe('running');

      const closed = await asAdmin()
        .post(`/api/v1/tasks/${res.body.run_id}/transitions`)
        .send({ transition: 'finish' });
      expect(closed.status).toBe(200);

      const execution = await settled(caseId, res.body.id);
      expect(execution).toMatchObject({
        status: 'succeeded',
        result: 'current',
        output: { amount: 7 },
      });
      expect((await nodeOf(caseId, 'pricing')).state).toBe('done');
    });

    test('an input changed while it ran supersedes its output', async () => {
      const caseId = await newCase({
        definition: runsOnAmount({ type: 'workflow', id: workflowId }),
      });
      await write(caseId, [{ node: 'pricing', name: 'amount', value: 7 }]);
      const res = await run(caseId, 'pricing');
      await write(caseId, [{ node: 'pricing', name: 'amount', value: 8 }]);

      await asAdmin()
        .post(`/api/v1/tasks/${res.body.run_id}/transitions`)
        .send({ transition: 'finish' });

      const execution = await settled(caseId, res.body.id);
      expect(execution).toMatchObject({
        status: 'succeeded',
        result: 'superseded',
        output_revision: null,
      });
      expect(await nodeOf(caseId, 'pricing')).toMatchObject({
        state: 'ready',
        output: null,
      });
    });

    test('returns 409 for a node that cannot run now', async () => {
      const caseId = await newCase({
        definition: readsAmount({ type: 'tool', id: doubleToolId }),
      });

      const blocked = await run(caseId, 'pricing');
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('PLAYBOOK_NODE_NOT_RUNNABLE');
      expect(blocked.body.error.meta).toMatchObject({
        state: 'blocked',
        waiting: ['revenue'],
      });

      await write(caseId, [{ node: 'revenue', name: 'amount', value: 1 }]);
      await run(caseId, 'revenue');
      const done = await run(caseId, 'revenue');
      expect(done.status).toBe(409);
      expect(done.body.error.meta.state).toBe('done');
    });

    test('returns 409 for a confirm node and for a running one', async () => {
      const caseId = await newCase({
        definition: {
          nodes: [
            ...runsOnAmount({ type: 'workflow', id: workflowId }).nodes,
            { key: 'approve', title: 'Approve', kind: 'confirm', inputs: [] },
          ],
        },
      });
      await write(caseId, [{ node: 'pricing', name: 'amount', value: 1 }]);

      const confirm = await run(caseId, 'approve');
      expect(confirm.status).toBe(409);
      expect(confirm.body.error.code).toBe('PLAYBOOK_NODE_NOT_RUNNABLE');

      await run(caseId, 'pricing');
      const running = await run(caseId, 'pricing');
      expect(running.status).toBe(409);
      expect(running.body.error.meta.state).toBe('running');
    });

    test('returns 400 for a node the version does not declare', async () => {
      const caseId = await newCase({
        definition: runsOnAmount({ type: 'tool', id: doubleToolId }),
      });
      const res = await run(caseId, 'nope');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('returns 403 once the author may no longer start the executor', async () => {
      const authorToken = await createScopedPrincipal({
        adminToken,
        projectId,
        username: 'pbkauthorrevoked',
        actions: ['playbooks:CreatePlaybook', 'tools:CallTool'],
      });
      const caseId = await newCase({
        definition: runsOnAmount({ type: 'tool', id: constantToolId }),
        token: authorToken,
      });
      await write(caseId, [{ node: 'pricing', name: 'amount', value: 1 }]);
      const me =
        await authenticatedTestClient(authorToken).get('/api/v1/users/me');
      await asAdmin()
        .put(`/api/v1/users/${me.body.id}/policies`)
        .send({ policy_ids: [] });

      const res = await run(caseId, 'pricing', { wait: true }, adminToken);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PLAYBOOK_EXECUTOR_FORBIDDEN');
      expect(res.body.error.meta).toEqual({
        node: 'pricing',
        action: 'tools:CallTool',
      });
    });

    test('returns 409 when the author no longer exists', async () => {
      const authorToken = await createScopedPrincipal({
        adminToken,
        projectId,
        username: 'pbkauthorgone',
        actions: ['playbooks:CreatePlaybook', 'tools:CallTool'],
      });
      const caseId = await newCase({
        definition: runsOnAmount({ type: 'tool', id: constantToolId }),
        token: authorToken,
      });
      await write(caseId, [{ node: 'pricing', name: 'amount', value: 1 }]);
      const me =
        await authenticatedTestClient(authorToken).get('/api/v1/users/me');
      expect(
        (await asAdmin().delete(`/api/v1/users/${me.body.id}`)).status
      ).toBe(204);

      const res = await run(caseId, 'pricing', { wait: true }, adminToken);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PLAYBOOK_AUTHOR_UNAVAILABLE');
    });

    test('returns 401 without a token', async () => {
      const res = await testClient
        .post('/api/v1/playbook-cases/pbk_case_absent/nodes/pricing/run')
        .send({});
      expect(res.status).toBe(401);
    });

    test('returns 404 to a caller without permission', async () => {
      const caseId = await newCase({
        definition: runsOnAmount({ type: 'tool', id: doubleToolId }),
      });
      const res = await run(caseId, 'pricing', {}, noPermToken);
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/v1/playbook-cases/{case_id}/executions', () => {
    test('lists executions newest first, by node', async () => {
      const caseId = await newCase({
        definition: readsAmount({ type: 'tool', id: doubleToolId }),
      });
      await write(caseId, [{ node: 'revenue', name: 'amount', value: 3 }]);
      const collect = await run(caseId, 'revenue');
      const tool = await run(caseId, 'pricing');

      const all = await authenticatedTestClient(userToken).get(
        `/api/v1/playbook-cases/${caseId}/executions`
      );
      expect(all.status).toBe(200);
      expect(
        all.body.data.map((row: { id: string }) => {
          return row.id;
        })
      ).toEqual([tool.body.id, collect.body.id]);

      const one = await authenticatedTestClient(userToken).get(
        `/api/v1/playbook-cases/${caseId}/executions?node=revenue`
      );
      expect(one.body.data).toHaveLength(1);
      expect(one.body.data[0].created_by).toEqual(expect.any(String));
    });

    test('returns 404 to a caller without permission', async () => {
      const caseId = await newCase({
        definition: runsOnAmount({ type: 'tool', id: doubleToolId }),
      });
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/playbook-cases/${caseId}/executions`
      );
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/v1/playbook-cases/{case_id}/executions/{execution_id}', () => {
    test('returns 404 for an execution of another case', async () => {
      const caseId = await newCase({
        definition: runsOnAmount({ type: 'tool', id: doubleToolId }),
      });
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/playbook-cases/${caseId}/executions/pbk_exe_absent`
      );
      expect(res.status).toBe(404);
    });

    test('returns 401 without a token', async () => {
      const res = await testClient.get(
        '/api/v1/playbook-cases/pbk_case_absent/executions/pbk_exe_absent'
      );
      expect(res.status).toBe(401);
    });
  });
});
