import { flushPlaybookExecutions } from 'src/lib/playbookCascade';

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
  'playbooks:ListPlaybookCases',
  'playbooks:PausePlaybookCase',
  'playbooks:ResumePlaybookCase',
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
        id: 'revenue',
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
        id: 'pricing',
        title: 'Pricing',
        kind: 'execute',
        final: true,
        inputs: [
          {
            name: 'amount',
            schema: { type: 'number' },
            required: true,
            source: { node_id: 'revenue', field: 'output.amount' },
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
        id: 'pricing',
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
    inputs: Array<{ node_id: string; name: string; value: unknown }>
  ) => {
    const current = await asAdmin().get(`/api/v1/playbook-cases/${caseId}`);
    const revisionOf = (node: string, name: string) => {
      const found = current.body.nodes.find((each: { id: string }) => {
        return each.id === node;
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
            expected_revision: revisionOf(input.node_id, input.name),
          };
        }),
      });
    expect(res.status).toBe(200);
    await flushPlaybookExecutions();
  };

  const executionsOf = async (caseId: string) => {
    const res = await asAdmin().get(
      `/api/v1/playbook-cases/${caseId}/executions?limit=100`
    );
    return res.body.data;
  };

  const pause = async (caseId: string) => {
    const res = await authenticatedTestClient(userToken).post(
      `/api/v1/playbook-cases/${caseId}/pause`
    );
    expect(res.status).toBe(200);
    return res.body;
  };

  const closeTask = async (taskId: string) => {
    const res = await asAdmin()
      .post(`/api/v1/tasks/${taskId}/transitions`)
      .send({ transition: 'finish' });
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
    return res.body.nodes.find((node: { id: string }) => {
      return node.id === key;
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

  describe('the cascade', () => {
    test('an input runs its collect node and then every node reading it', async () => {
      const caseId = await newCase({
        definition: readsAmount({
          type: 'tool',
          id: doubleToolId,
          input: { value: { var: 'amount' } },
        }),
      });

      await write(caseId, [{ node_id: 'revenue', name: 'amount', value: 21 }]);

      expect(await nodeOf(caseId, 'revenue')).toMatchObject({
        state: 'done',
        output: { value: { amount: 21 }, revision: 2 },
      });
      expect(await nodeOf(caseId, 'pricing')).toMatchObject({
        state: 'done',
        output: { value: { doubled: 42 }, revision: 3 },
      });
      const [tool, collect] = await executionsOf(caseId);
      expect(collect).toMatchObject({
        node_id: 'revenue',
        executor: null,
        status: 'completed',
        result: 'current',
        created_by_principal_type: null,
        created_by_principal_id: null,
      });
      expect(tool).toMatchObject({
        node_id: 'pricing',
        executor: { type: 'tool', id: doubleToolId },
        input: { value: 21 },
        output: { doubled: 42 },
      });
    });

    test('an equal output writes no revision and stops there', async () => {
      const caseId = await newCase({
        definition: runsOnAmount({ type: 'tool', id: constantToolId }),
      });
      await write(caseId, [{ node_id: 'pricing', name: 'amount', value: 1 }]);

      await write(caseId, [{ node_id: 'pricing', name: 'amount', value: 2 }]);

      const [second, first] = await executionsOf(caseId);
      expect(first.output_revision).toBe(2);
      expect(second).toMatchObject({
        output: { ok: true },
        output_revision: null,
      });
      expect(await nodeOf(caseId, 'pricing')).toMatchObject({
        state: 'done',
        output: { revision: 2 },
      });
    });

    test('a failed node stays failed until it is run again', async () => {
      const caseId = await newCase({
        definition: runsOnAmount({ type: 'tool', id: failingToolId }),
      });
      await write(caseId, [{ node_id: 'pricing', name: 'amount', value: 1 }]);

      expect((await nodeOf(caseId, 'pricing')).state).toBe('failed');
      const [failed] = await executionsOf(caseId);
      expect(failed.error).toEqual(
        expect.objectContaining({ code: expect.any(String) })
      );

      const retried = await run(caseId, 'pricing');
      expect(retried.status).toBe(201);
      expect(retried.body.status).toBe('failed');
      expect(await executionsOf(caseId)).toHaveLength(2);
    });

    test('an agent node answers with its text', async () => {
      stub.reply(textCompletion('Simples Nacional'));
      const caseId = await newCase({
        definition: runsOnAmount({ type: 'agent', id: agentId }),
      });
      await write(caseId, [{ node_id: 'pricing', name: 'amount', value: 1 }]);

      expect((await executionsOf(caseId))[0]).toMatchObject({
        status: 'completed',
        output: 'Simples Nacional',
        run_id: expect.stringMatching(/^gen_/),
      });
    });

    test('an agent that stops for a client tool fails the node', async () => {
      stub.reply(toolCallCompletion([{ id: 'call_confirm', name: 'confirm' }]));
      const caseId = await newCase({
        definition: runsOnAmount({ type: 'agent', id: clientToolAgentId }),
      });
      await write(caseId, [{ node_id: 'pricing', name: 'amount', value: 1 }]);

      expect((await executionsOf(caseId))[0]).toMatchObject({
        status: 'failed',
        error: { code: 'PLAYBOOK_EXECUTION_FAILED' },
      });
    });

    test('a decider node answers with its answers by name', async () => {
      const caseId = await newCase({
        definition: runsOnAmount({ type: 'decider', id: deciderId }),
      });
      await write(caseId, [{ node_id: 'pricing', name: 'amount', value: 1 }]);

      const [execution] = await executionsOf(caseId);
      expect(execution.status).toBe('completed');
      expect(execution.output.escalate).toMatchObject({ probability: 0.9 });
      expect(execution.run_id).toMatch(/^dec/);
    });

    test('a failed decision fails the node', async () => {
      const caseId = await newCase({
        definition: runsOnAmount({ type: 'decider', id: misdeciderId }),
      });
      await write(caseId, [{ node_id: 'pricing', name: 'amount', value: 1 }]);

      expect((await nodeOf(caseId, 'pricing')).state).toBe('failed');
    });

    test('an orchestration node answers with its run output', async () => {
      const caseId = await newCase({
        definition: runsOnAmount({
          type: 'orchestration',
          id: orchestrationId,
        }),
      });
      await write(caseId, [{ node_id: 'pricing', name: 'amount', value: 1 }]);

      expect((await executionsOf(caseId))[0].status).toBe('completed');
      expect((await nodeOf(caseId, 'pricing')).state).toBe('done');
    });

    test('a failed orchestration run fails the node', async () => {
      const caseId = await newCase({
        definition: runsOnAmount({
          type: 'orchestration',
          id: failingOrchestrationId,
        }),
      });
      await write(caseId, [{ node_id: 'pricing', name: 'amount', value: 1 }]);

      expect((await executionsOf(caseId))[0]).toMatchObject({
        status: 'failed',
        error: { code: 'PLAYBOOK_EXECUTION_FAILED' },
      });
    });

    test('an orchestration run parked on a person settles when it ends', async () => {
      const caseId = await newCase({
        definition: runsOnAmount({
          type: 'orchestration',
          id: humanOrchestrationId,
        }),
      });
      await write(caseId, [{ node_id: 'pricing', name: 'amount', value: 1 }]);
      const [parked] = await executionsOf(caseId);
      expect(parked.status).toBe('running');

      const answered = await asAdmin()
        .post(`/api/v1/orchestration-runs/${parked.run_id}/human-input`)
        .send({ node_id: 'ask', output: { approved: true } });
      expect(answered.body.status).toBe('completed');

      expect((await settled(caseId, parked.id)).status).toBe('completed');
      expect((await nodeOf(caseId, 'pricing')).state).toBe('done');
    });

    test('a workflow node settles when its task closes', async () => {
      const caseId = await newCase({
        definition: runsOnAmount({ type: 'workflow', id: workflowId }),
      });
      await write(caseId, [{ node_id: 'pricing', name: 'amount', value: 7 }]);
      const [parked] = await executionsOf(caseId);
      expect(parked.run_id).toMatch(/^task_/);
      expect((await nodeOf(caseId, 'pricing')).state).toBe('waiting');

      await closeTask(parked.run_id);

      expect(await settled(caseId, parked.id)).toMatchObject({
        status: 'completed',
        result: 'current',
        output: { amount: 7 },
      });
      expect((await nodeOf(caseId, 'pricing')).state).toBe('done');
    });

    test('an input changed while it ran supersedes it, and the node runs again', async () => {
      const caseId = await newCase({
        definition: runsOnAmount({ type: 'workflow', id: workflowId }),
      });
      await write(caseId, [{ node_id: 'pricing', name: 'amount', value: 7 }]);
      const [first] = await executionsOf(caseId);
      await write(caseId, [{ node_id: 'pricing', name: 'amount', value: 8 }]);
      expect(await executionsOf(caseId)).toHaveLength(1);

      await closeTask(first.run_id);

      expect(await settled(caseId, first.id)).toMatchObject({
        result: 'superseded',
        output_revision: null,
      });
      const again = await pollUntil({
        read: () => {
          return executionsOf(caseId);
        },
        // The rerun is inserted `queued`; the worker claims it a tick later.
        done: (rows) => {
          return rows.length === 2 && rows[0].status !== 'queued';
        },
      });
      expect(again[0]).toMatchObject({
        status: 'running',
        input: { amount: 8 },
      });
    });

    test('runs as the author, and fails once the author may no longer start it', async () => {
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
      const me =
        await authenticatedTestClient(authorToken).get('/api/v1/users/me');
      await asAdmin()
        .put(`/api/v1/users/${me.body.id}/policies`)
        .send({ policy_ids: [] });

      await write(caseId, [{ node_id: 'pricing', name: 'amount', value: 1 }]);

      expect((await executionsOf(caseId))[0].error).toMatchObject({
        code: 'PLAYBOOK_EXECUTOR_FORBIDDEN',
        meta: { node_id: 'pricing', action: 'tools:CallTool' },
      });
      const res = await run(caseId, 'pricing', { wait: true }, adminToken);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PLAYBOOK_EXECUTOR_FORBIDDEN');
    });

    test('fails when the author no longer exists', async () => {
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
      const me =
        await authenticatedTestClient(authorToken).get('/api/v1/users/me');
      expect(
        (await asAdmin().delete(`/api/v1/users/${me.body.id}`)).status
      ).toBe(204);

      await write(caseId, [{ node_id: 'pricing', name: 'amount', value: 1 }]);

      expect((await executionsOf(caseId))[0].error.code).toBe(
        'PLAYBOOK_AUTHOR_UNAVAILABLE'
      );
      const res = await run(caseId, 'pricing', { wait: true }, adminToken);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PLAYBOOK_AUTHOR_UNAVAILABLE');
    });
  });

  describe('POST /api/v1/playbook-cases/{case_id}/inputs with wait', () => {
    const writeAndWait = async (caseId: string, value: number) => {
      return asAdmin()
        .post(`/api/v1/playbook-cases/${caseId}/inputs`)
        .send({
          inputs: [
            {
              node_id: 'revenue',
              name: 'amount',
              value,
              expected_revision: null,
            },
          ],
          wait: true,
        });
    };

    test('answers once every node the write reaches has settled', async () => {
      const caseId = await newCase({
        definition: readsAmount({
          type: 'tool',
          id: doubleToolId,
          input: { value: { var: 'amount' } },
        }),
      });

      const res = await writeAndWait(caseId, 21);

      expect(res.status).toBe(200);
      expect(res.body.automation_status).toBe('idle');
      const pricing = res.body.nodes.find((node: { id: string }) => {
        return node.id === 'pricing';
      });
      expect(pricing).toMatchObject({
        state: 'done',
        output: { value: { doubled: 42 } },
      });
    });

    test('answers once a node parks on the task it started', async () => {
      const caseId = await newCase({
        definition: readsAmount({ type: 'workflow', id: workflowId }),
      });

      const res = await writeAndWait(caseId, 1);

      expect(res.status).toBe(200);
      expect(res.body.automation_status).toBe('waiting');
    });

    test('answers at once on a paused case', async () => {
      const caseId = await newCase({
        definition: readsAmount({ type: 'tool', id: doubleToolId }),
      });
      await pause(caseId);

      const res = await writeAndWait(caseId, 1);

      expect(res.status).toBe(200);
      expect(res.body.automation_status).toBe('paused');
    });
  });

  describe('POST /api/v1/playbook-cases/{case_id}/nodes/{node}/run', () => {
    test('without wait it answers running and settles in the background', async () => {
      const caseId = await newCase({
        definition: runsOnAmount({ type: 'tool', id: failingToolId }),
      });
      await write(caseId, [{ node_id: 'pricing', name: 'amount', value: 1 }]);

      const res = await run(caseId, 'pricing', {});

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        id: expect.stringMatching(/^pbk_exe_/),
        case_id: caseId,
        status: 'running',
        created_by_principal_type: 'user',
        created_by_principal_id: expect.stringMatching(/^user_/),
      });
      expect((await settled(caseId, res.body.id)).status).toBe('failed');
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
        blocked_by: ['revenue'],
      });
    });

    test('runs a done node again, and an equal output writes no revision', async () => {
      const caseId = await newCase({
        definition: runsOnAmount({ type: 'tool', id: constantToolId }),
      });
      await write(caseId, [{ node_id: 'pricing', name: 'amount', value: 1 }]);
      const before = await nodeOf(caseId, 'pricing');
      expect(before.state).toBe('done');

      const res = await run(caseId, 'pricing');

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        status: 'completed',
        output: { ok: true },
        output_revision: null,
      });
      expect(await nodeOf(caseId, 'pricing')).toMatchObject({
        state: 'done',
        output: { revision: before.output.revision },
      });
    });

    test('returns 409 for a confirm node and for one waiting on its task', async () => {
      const caseId = await newCase({
        definition: {
          nodes: [
            ...runsOnAmount({ type: 'workflow', id: workflowId }).nodes,
            { id: 'approve', title: 'Approve', kind: 'confirm', inputs: [] },
          ],
        },
      });
      await write(caseId, [{ node_id: 'pricing', name: 'amount', value: 1 }]);

      const confirm = await run(caseId, 'approve');
      expect(confirm.status).toBe(409);
      expect(confirm.body.error.code).toBe('PLAYBOOK_NODE_NOT_RUNNABLE');

      const waiting = await run(caseId, 'pricing');
      expect(waiting.status).toBe(409);
      expect(waiting.body.error.meta.state).toBe('waiting');
    });

    test('returns 409 while the case is paused', async () => {
      const caseId = await newCase({
        definition: runsOnAmount({ type: 'tool', id: failingToolId }),
      });
      await write(caseId, [{ node_id: 'pricing', name: 'amount', value: 1 }]);
      await pause(caseId);

      const res = await run(caseId, 'pricing');

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PLAYBOOK_CASE_PAUSED');
    });

    test('returns 400 for a node the version does not declare', async () => {
      const caseId = await newCase({
        definition: runsOnAmount({ type: 'tool', id: doubleToolId }),
      });
      const res = await run(caseId, 'nope');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
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

  describe('POST /api/v1/playbook-cases/{case_id}/pause and /resume', () => {
    test('a paused case starts nothing until it is resumed', async () => {
      const caseId = await newCase({
        definition: readsAmount({
          type: 'tool',
          id: doubleToolId,
          input: { value: { var: 'amount' } },
        }),
      });

      const paused = await pause(caseId);
      expect(paused).toMatchObject({
        automation_status: 'paused',
        pause_requested_at: expect.any(String),
      });
      await write(caseId, [{ node_id: 'revenue', name: 'amount', value: 2 }]);
      expect(await executionsOf(caseId)).toEqual([]);
      expect((await pause(caseId)).pause_requested_at).toBe(
        paused.pause_requested_at
      );

      const resumed = await authenticatedTestClient(userToken).post(
        `/api/v1/playbook-cases/${caseId}/resume`
      );
      expect(resumed.status).toBe(200);
      expect(resumed.body.pause_requested_at).toBeNull();
      await flushPlaybookExecutions();
      expect((await nodeOf(caseId, 'pricing')).output.value).toEqual({
        doubled: 4,
      });
    });

    test('resume returns 409 for a case that is not paused', async () => {
      const caseId = await newCase({
        definition: runsOnAmount({ type: 'tool', id: doubleToolId }),
      });
      const res = await authenticatedTestClient(userToken).post(
        `/api/v1/playbook-cases/${caseId}/resume`
      );
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PLAYBOOK_CASE_NOT_PAUSED');
    });

    test('returns 401 without a token', async () => {
      const res = await testClient.post(
        '/api/v1/playbook-cases/pbk_case_absent/pause'
      );
      expect(res.status).toBe(401);
    });

    test('returns 404 to a caller without permission', async () => {
      const caseId = await newCase({
        definition: runsOnAmount({ type: 'tool', id: doubleToolId }),
      });
      const res = await authenticatedTestClient(noPermToken).post(
        `/api/v1/playbook-cases/${caseId}/resume`
      );
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/v1/playbook-cases?automation_status=', () => {
    test('lists cases by what their automation is doing', async () => {
      const onTask = await newCase({
        definition: runsOnAmount({ type: 'workflow', id: workflowId }),
      });
      await write(onTask, [{ node_id: 'pricing', name: 'amount', value: 1 }]);
      const onRun = await newCase({
        definition: runsOnAmount({
          type: 'orchestration',
          id: humanOrchestrationId,
        }),
      });
      await write(onRun, [{ node_id: 'pricing', name: 'amount', value: 1 }]);
      const paused = await newCase({
        definition: runsOnAmount({ type: 'tool', id: doubleToolId }),
      });
      await pause(paused);
      const idle = await newCase({
        definition: runsOnAmount({ type: 'tool', id: doubleToolId }),
      });
      const running = await newCase({
        definition: runsOnAmount({ type: 'tool', id: doubleToolId }),
      });

      const idsIn = async (status: string) => {
        const res = await authenticatedTestClient(userToken).get(
          `/api/v1/playbook-cases?project_id=${projectId}&automation_status=${status}&limit=100`
        );
        expect(res.status).toBe(200);
        return res.body.data.map(
          (row: { id: string; automation_status: string }) => {
            expect(row.automation_status).toBe(status);
            return row.id;
          }
        );
      };

      // With the worker off the write only queues the execution.
      process.env.PLAYBOOK_WORKER_DISABLED = 'true';
      try {
        await write(running, [
          { node_id: 'pricing', name: 'amount', value: 1 },
        ]);
        const runningIds = await idsIn('running');
        expect(runningIds).toContain(running);
        expect(runningIds).not.toContain(onTask);
        expect(runningIds).not.toContain(onRun);
        expect(await idsIn('waiting')).toEqual(
          expect.arrayContaining([onTask, onRun])
        );
        expect(await idsIn('paused')).toContain(paused);
        expect(await idsIn('idle')).toContain(idle);
      } finally {
        delete process.env.PLAYBOOK_WORKER_DISABLED;
      }
      await pause(running);
    });

    test('a case waiting on a task it started reads waiting until the task closes', async () => {
      const caseId = await newCase({
        definition: runsOnAmount({ type: 'workflow', id: workflowId }),
      });
      await write(caseId, [{ node_id: 'pricing', name: 'amount', value: 1 }]);

      const waiting = await asAdmin().get(`/api/v1/playbook-cases/${caseId}`);
      expect(waiting.body.automation_status).toBe('waiting');
      const [parked] = await executionsOf(caseId);
      expect(parked).toMatchObject({ status: 'running' });
      expect(await nodeOf(caseId, 'pricing')).toMatchObject({
        state: 'waiting',
        run: {
          type: 'task',
          id: parked.run_id,
          state: 'open',
          automation_status: null,
        },
      });

      await closeTask(parked.run_id);
      await settled(caseId, parked.id);
      const closed = await asAdmin().get(`/api/v1/playbook-cases/${caseId}`);
      expect(closed.body.automation_status).toBe('idle');
      expect(await nodeOf(caseId, 'pricing')).toMatchObject({
        state: 'done',
        run: null,
      });
    });

    test('a repeated automation_status filter ORs its values', async () => {
      const paused = await newCase({
        definition: runsOnAmount({ type: 'tool', id: doubleToolId }),
      });
      await pause(paused);
      const idle = await newCase({
        definition: runsOnAmount({ type: 'tool', id: doubleToolId }),
      });

      const idsIn = async (query: string) => {
        const res = await authenticatedTestClient(userToken).get(
          `/api/v1/playbook-cases?project_id=${projectId}&${query}&limit=100`
        );
        expect(res.status).toBe(200);
        return res.body.data.map((row: { id: string }) => {
          return row.id;
        });
      };

      expect(
        await idsIn('automation_status=idle&automation_status=paused')
      ).toEqual(expect.arrayContaining([paused, idle]));
      const pausedOrRunning = await idsIn(
        'automation_status=paused&automation_status=running'
      );
      expect(pausedOrRunning).toContain(paused);
      expect(pausedOrRunning).not.toContain(idle);
    });

    test('returns 400 for an unknown status', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/playbook-cases?project_id=${projectId}&automation_status=busy`
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('GET /api/v1/playbook-cases/{case_id}, a node waiting on a run it started', () => {
    test('names the orchestration run and its status', async () => {
      const caseId = await newCase({
        definition: runsOnAmount({
          type: 'orchestration',
          id: humanOrchestrationId,
        }),
      });
      await write(caseId, [{ node_id: 'pricing', name: 'amount', value: 1 }]);

      const [parked] = await executionsOf(caseId);
      expect(await nodeOf(caseId, 'pricing')).toMatchObject({
        state: 'waiting',
        run: {
          type: 'orchestration_run',
          id: parked.run_id,
          status: 'awaiting_input',
        },
      });
    });

    test('reads null fields for a task that no longer exists', async () => {
      const caseId = await newCase({
        definition: runsOnAmount({ type: 'workflow', id: workflowId }),
      });
      await write(caseId, [{ node_id: 'pricing', name: 'amount', value: 1 }]);
      const [parked] = await executionsOf(caseId);

      const deleted = await asAdmin().delete(`/api/v1/tasks/${parked.run_id}`);
      expect(deleted.status).toBe(204);

      expect(await nodeOf(caseId, 'pricing')).toMatchObject({
        state: 'waiting',
        run: {
          type: 'task',
          id: parked.run_id,
          state: null,
          automation_status: null,
        },
      });
    });

    test('shows a task whose automation failed', async () => {
      const failingWorkflowId = await create('/api/v1/workflows', {
        name: `exec-failing-review-${seq}`,
        states: [
          {
            name: 'call',
            initial: true,
            on_enter: {
              dispatch: { kind: 'tool', tool_id: failingToolId },
              on_complete: [{ when: true, transition: 'finish' }],
            },
          },
          { name: 'done', terminal: true },
        ],
        transitions: [{ name: 'finish', from: ['call'], to: 'done' }],
      });
      const caseId = await newCase({
        definition: runsOnAmount({ type: 'workflow', id: failingWorkflowId }),
      });
      await write(caseId, [{ node_id: 'pricing', name: 'amount', value: 1 }]);

      const [parked] = await executionsOf(caseId);
      const node = await pollUntil({
        read: () => {
          return nodeOf(caseId, 'pricing');
        },
        done: (current) => {
          return current.run?.automation_status === 'failed';
        },
      });
      expect(node).toMatchObject({
        state: 'waiting',
        run: {
          type: 'task',
          id: parked.run_id,
          state: 'call',
          automation_status: 'failed',
        },
      });
    });
  });

  describe('GET /api/v1/playbook-cases/{case_id}/executions', () => {
    test('filters by node', async () => {
      const caseId = await newCase({
        definition: readsAmount({ type: 'tool', id: doubleToolId }),
      });
      await write(caseId, [{ node_id: 'revenue', name: 'amount', value: 3 }]);

      const one = await authenticatedTestClient(userToken).get(
        `/api/v1/playbook-cases/${caseId}/executions?node_id=revenue`
      );
      expect(one.status).toBe(200);
      expect(one.body.data).toHaveLength(1);
      expect(one.body.data[0].node_id).toBe('revenue');
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
