import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient, testClient } from '../../testClient';

describe('A loop node’s item_tool_context', () => {
  let adminToken: string;
  let userToken: string;
  let noPermToken: string;
  let projectId: string;
  let agentId: string;

  const client = () => {
    return authenticatedTestClient(userToken);
  };

  const createOrchestration = (body: Record<string, unknown>) => {
    return client()
      .post('/api/v1/orchestrations')
      .send({ project_id: projectId, edges: [], ...body });
  };

  const createdId = async (body: Record<string, unknown>) => {
    const res = await createOrchestration(body);
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const agentChild = (name: string) => {
    return createdId({
      name,
      nodes: [
        {
          id: 'ask',
          type: 'agent',
          agent_id: agentId,
          input_mapping: { prompt: 'sync' },
        },
      ],
    });
  };

  const loopNode = (args: {
    childId: string;
    itemToolContext: unknown;
    extra?: Record<string, unknown>;
  }) => {
    return {
      id: 'fan',
      type: 'loop',
      orchestration_id: args.childId,
      collection: 'state.input.actors',
      item_variable: 'actor',
      item_tool_context: args.itemToolContext,
      state_mapping: {
        'state.results': { var: 'output.results' },
        'state.failed_count': { var: 'output.failed_count' },
      },
      ...args.extra,
    };
  };

  const startRun = async (args: {
    orchestrationId: string;
    input: Record<string, unknown>;
    toolContext?: Record<string, string>;
  }) => {
    const res = await client().post('/api/v1/orchestration-runs').send({
      wait: true,
      orchestration_id: args.orchestrationId,
      input: args.input,
      tool_context: args.toolContext,
    });
    expect(res.status).toBe(201);
    return res.body;
  };

  const stubGeneration = () => {
    return mockCreateGeneration.mockResolvedValue({
      id: 'gen_itemctx01',
      traceId: 'trc_itemctx01',
      status: 'completed',
      output: { model: 'llama3.2', content: 'ok', finishReason: 'stop' },
    });
  };

  const seenToolContexts = (spy: typeof mockCreateGeneration) => {
    return spy.mock.calls.map((call) => {
      return call[0].toolContext;
    });
  };

  // The spy is shared by the suite: restoring it would disconnect it.
  afterEach(() => {
    mockCreateGeneration.mockReset();
  });

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'loopitemctx',
      policyActions: [
        'agents:CreateAgentGeneration',
        'orchestrations:CreateOrchestration',
        'orchestrations:GetOrchestration',
        'orchestrations:UpdateOrchestration',
        'orchestrations:StartRun',
        'orchestrations:GetRun',
        'orchestrations:SubmitHumanInput',
      ],
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    noPermToken = setup.noPermToken as string;
    projectId = setup.projectId;

    const provider = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Loop Item Ctx Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    expect(provider.status).toBe(201);
    const agent = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        name: 'Loop Item Ctx Agent',
        ai_provider_id: provider.body.id,
      });
    expect(agent.status).toBe(201);
    agentId = agent.body.id;
  });

  describe('at run time', () => {
    test('gives each child run only its own item’s keys', async () => {
      const childId = await agentChild('Per Actor Child');
      const parentId = await createdId({
        name: 'Per Actor Fan-out',
        nodes: [
          loopNode({
            childId,
            itemToolContext: {
              x_actor: { var: 'actor.id' },
              x_memory_store: { var: 'actor.memory_store' },
              x_region: { var: 'state.input.region' },
            },
          }),
        ],
      });

      const spy = stubGeneration();
      try {
        const run = await startRun({
          orchestrationId: parentId,
          input: {
            region: 'eu',
            actors: [
              { id: 'act_one', memory_store: 'mem_one' },
              { id: 'act_two', memory_store: 'mem_two' },
            ],
          },
          toolContext: { tenant: 'acme' },
        });
        expect(run.status).toBe('completed');

        const seen = seenToolContexts(spy).sort((a, b) => {
          return String(a?.x_actor).localeCompare(String(b?.x_actor));
        });
        expect(seen).toEqual([
          {
            tenant: 'acme',
            x_actor: 'act_one',
            x_memory_store: 'mem_one',
            x_region: 'eu',
          },
          {
            tenant: 'acme',
            x_actor: 'act_two',
            x_memory_store: 'mem_two',
            x_region: 'eu',
          },
        ]);
      } finally {
        spy.mockClear();
      }
    });

    test('overlays the bag context_keys narrowed, an item key replacing an inherited one in any casing', async () => {
      const childId = await agentChild('Overlay Child');
      const parentId = await createdId({
        name: 'Overlay Fan-out',
        nodes: [
          loopNode({
            childId,
            itemToolContext: { tenant: { var: 'actor.tenant' } },
            extra: { context_keys: ['TENANT', 'region'] },
          }),
        ],
      });

      const spy = stubGeneration();
      try {
        const run = await startRun({
          orchestrationId: parentId,
          input: { actors: [{ tenant: 'globex' }] },
          toolContext: { ocaToken: 'tok_secret', TENANT: 'acme', region: 'eu' },
        });
        expect(run.status).toBe('completed');
        expect(seenToolContexts(spy)).toEqual([
          { region: 'eu', tenant: 'globex' },
        ]);
      } finally {
        spy.mockClear();
      }
    });

    // An item without a value must not run under the parent's: in a per-actor
    // fan-out that would be another actor's store.
    test('a key evaluating to null drops it, the inherited value included', async () => {
      const childId = await agentChild('Null Child');
      const parentId = await createdId({
        name: 'Null Fan-out',
        nodes: [
          loopNode({
            childId,
            itemToolContext: { x_memory_store: { var: 'actor.memory_store' } },
          }),
        ],
      });

      const spy = stubGeneration();
      try {
        const run = await startRun({
          orchestrationId: parentId,
          input: { actors: [{ id: 'act_one' }] },
          toolContext: { tenant: 'acme', x_memory_store: 'mem_parent' },
        });
        expect(run.status).toBe('completed');
        expect(seenToolContexts(spy)).toEqual([{ tenant: 'acme' }]);
      } finally {
        spy.mockClear();
      }
    });

    test('a non-string value under collect fails that item only, in place', async () => {
      const childId = await agentChild('Collect Child');
      const parentId = await createdId({
        name: 'Collect Fan-out',
        nodes: [
          loopNode({
            childId,
            itemToolContext: { x_actor: { var: 'actor.id' } },
            extra: { on_item_error: 'collect' },
          }),
        ],
      });

      const spy = stubGeneration();
      try {
        const run = await startRun({
          orchestrationId: parentId,
          input: {
            actors: [{ id: 'act_one' }, { id: 7 }, { id: 'act_three' }],
          },
        });
        expect(run.status).toBe('completed');
        expect(run.state.failed_count).toBe(1);
        expect(run.state.results).toHaveLength(3);
        expect(run.state.results[1]).toEqual({
          error: {
            code: 'LOOP_ITEM_TOOL_CONTEXT_INVALID',
            message: expect.stringMatching(/x_actor/),
          },
        });
        expect(run.state.results[0]).toMatchObject({ ask: {} });
        expect(run.state.results[2]).toMatchObject({ ask: {} });
        expect(spy).toHaveBeenCalledTimes(2);
      } finally {
        spy.mockClear();
      }
    });

    test('a non-string value under fail fails the node before any child starts', async () => {
      const childId = await agentChild('Fail Child');
      const parentId = await createdId({
        name: 'Fail Fan-out',
        nodes: [
          loopNode({
            childId,
            itemToolContext: { x_actor: { var: 'actor.id' } },
          }),
        ],
      });

      const spy = stubGeneration();
      try {
        const run = await startRun({
          orchestrationId: parentId,
          input: { actors: [{ id: 'act_one' }, { id: { nested: true } }] },
        });
        expect(run.status).toBe('failed');
        expect(run.error).toMatchObject({
          code: 'LOOP_ITEM_TOOL_CONTEXT_INVALID',
        });
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockClear();
      }
    });

    test('an expression that throws fails that item under collect', async () => {
      const childId = await agentChild('Throw Child');
      const parentId = await createdId({
        name: 'Throw Fan-out',
        nodes: [
          loopNode({
            childId,
            itemToolContext: {
              x_actor: {
                if: [
                  { var: 'actor.id' },
                  { var: 'actor.id' },
                  { throw: 'no id' },
                ],
              },
            },
            extra: { on_item_error: 'collect' },
          }),
        ],
      });

      const spy = stubGeneration();
      try {
        const run = await startRun({
          orchestrationId: parentId,
          input: { actors: [{}, { id: 'act_two' }] },
        });
        expect(run.status).toBe('completed');
        expect(run.state.results[0]).toEqual({
          error: { code: 'EXPRESSION_FAILED', message: expect.any(String) },
        });
        expect(run.state.failed_count).toBe(1);
        expect(seenToolContexts(spy)).toEqual([{ x_actor: 'act_two' }]);
      } finally {
        spy.mockClear();
      }
    });

    test('a failed item keeps its place when the node parks on the others', async () => {
      const childId = await createdId({
        name: 'Parking Child',
        nodes: [{ id: 'ask', type: 'human', prompt: 'Answer?' }],
      });
      const parentId = await createdId({
        name: 'Parking Fan-out',
        nodes: [
          loopNode({
            childId,
            itemToolContext: { x_actor: { var: 'actor.id' } },
            extra: { on_item_error: 'collect' },
          }),
        ],
      });

      const parked = await startRun({
        orchestrationId: parentId,
        input: { actors: [{ id: 7 }, { id: 'act_two' }] },
      });
      expect(parked.status).toBe('awaiting_input');
      const [childRunId] = parked.required_action.context
        .orchestration_run_ids as string[];

      const answered = await client()
        .post(`/api/v1/orchestration-runs/${childRunId}/human-input`)
        .send({ node_id: 'ask', output: { answer: 'yes' } });
      expect(answered.status).toBe(200);

      const settled = await client().get(
        `/api/v1/orchestration-runs/${parked.id}`
      );
      expect(settled.body.status).toBe('completed');
      expect(settled.body.state.results).toEqual([
        {
          error: {
            code: 'LOOP_ITEM_TOOL_CONTEXT_INVALID',
            message: expect.any(String),
          },
        },
        { ask: { answer: 'yes' } },
      ]);
      expect(settled.body.state.failed_count).toBe(1);
    });
  });

  describe('at write time', () => {
    let childId: string;

    beforeAll(async () => {
      childId = await agentChild('Write Time Child');
    });

    test('is echoed back on create and read', async () => {
      const itemToolContext = { x_actor: { var: 'actor.id' } };
      const created = await createOrchestration({
        name: 'Echo Fan-out',
        nodes: [loopNode({ childId, itemToolContext })],
      });
      expect(created.status).toBe(201);
      expect(created.body.nodes[0].item_tool_context).toEqual(itemToolContext);

      const read = await client().get(
        `/api/v1/orchestrations/${created.body.id}`
      );
      expect(read.body.nodes[0].item_tool_context).toEqual(itemToolContext);
    });

    test.each([
      ['a key outside the header-name grammar', { 'bad key': 'x' }],
      ['two keys differing only in case', { x_actor: 'a', X_ACTOR: 'b' }],
      ['a reserved identity key', { actor_id: { var: 'actor.id' } }],
      ['a reserved key in another casing', { Session_ID: 's' }],
      ['calling_project_id', { calling_project_id: 'proj_x' }],
      ['a value that is not an object', ['x_actor']],
    ])('rejects %s at create', async (_label, itemToolContext) => {
      const res = await createOrchestration({
        name: 'Rejected Fan-out',
        nodes: [loopNode({ childId, itemToolContext })],
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_TOOL_CONTEXT_KEY');
    });

    test('rejects a reserved key on update', async () => {
      const id = await createdId({
        name: 'Patched Fan-out',
        nodes: [loopNode({ childId, itemToolContext: { x_actor: 'a' } })],
      });
      const res = await client()
        .patch(`/api/v1/orchestrations/${id}`)
        .send({
          nodes: [
            loopNode({ childId, itemToolContext: { actor_external_id: 'a' } }),
          ],
          edges: [],
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_TOOL_CONTEXT_KEY');
    });

    test('401 without a token', async () => {
      const res = await testClient.post('/api/v1/orchestrations').send({
        project_id: projectId,
        name: 'Anon Fan-out',
        edges: [],
        nodes: [loopNode({ childId, itemToolContext: { x_actor: 'a' } })],
      });
      expect(res.status).toBe(401);
    });

    test('a caller without permission cannot create one', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .post('/api/v1/orchestrations')
        .send({
          project_id: projectId,
          name: 'NoPerm Fan-out',
          edges: [],
          nodes: [loopNode({ childId, itemToolContext: { x_actor: 'a' } })],
        });
      expect(res.status).toBe(403);
    });
  });
});
