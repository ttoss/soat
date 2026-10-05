import type http from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { db } from 'src/db';
import { DEFAULT_TOOL_APPROVAL_EXPIRES_IN_SECONDS } from 'src/lib/agentToolApproval';
import { expireDueApprovals } from 'src/lib/approvalScheduler';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * A class-C guardrail on a bound tool routes each of the agent's calls to an
 * approval instead of running it, and the turn carries on with a
 * `pending_approval` result. Under a forcing `tool_choice` every step is such a
 * call, so the turn can only end on its step budget or on the terminal tool the
 * agent declares; once the held calls expire, the sweeper resumes an agent that
 * reacts to expiry and ends the chain of one that does not.
 *
 * The provider is a local fake that honors `tool_choice` the way a real one
 * does: forced, it can only answer with a call to `forcedToolName`; unforced, it
 * answers in text.
 */
describe('Guardrail-routed tool approvals', () => {
  const MAX_STEPS = 2;
  const REFUND_TOOL = 'routing-refund';
  const DONE_TOOL = 'done';

  let adminToken: string;
  let modelServer: http.Server;
  let toolServer: http.Server;
  let modelBaseUrl: string;
  let toolBaseUrl: string;
  let modelRequests: Array<Record<string, unknown>> = [];
  let toolRequests: Array<{ url: string; body: Record<string, unknown> }> = [];
  let proposalCount = 0;
  let forcedToolName = REFUND_TOOL;
  /** The arguments of the next forced call; distinct per call unless a test pins them. */
  let nextArguments: () => Record<string, unknown> = () => {
    return { amount: proposalCount };
  };
  let fixtureCount = 0;

  const forcesATool = (toolChoice: unknown): boolean => {
    return (
      toolChoice === 'required' ||
      (typeof toolChoice === 'object' && toolChoice !== null)
    );
  };

  const readJson = (req: http.IncomingMessage): Promise<unknown> => {
    return new Promise((resolve) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        resolve(raw ? JSON.parse(raw) : {});
      });
    });
  };

  const completionFor = (body: Record<string, unknown>) => {
    proposalCount += 1;
    const forced = forcesATool(body.tool_choice);
    const message = forced
      ? {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: `call_routing_${proposalCount}`,
              type: 'function',
              function: {
                name: forcedToolName,
                arguments: JSON.stringify(nextArguments()),
              },
            },
          ],
        }
      : { role: 'assistant', content: 'The refund request is stale.' };
    return {
      id: 'chatcmpl-routing',
      object: 'chat.completion',
      created: 0,
      model: 'stub-model',
      choices: [
        {
          index: 0,
          message,
          finish_reason: forced ? 'tool_calls' : 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  };

  const listen = async (server: http.Server): Promise<string> => {
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  const close = async (server: http.Server): Promise<void> => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        return resolve();
      });
    });
  };

  const waitFor = async <T>(args: {
    probe: () => Promise<T | undefined>;
    describe: string;
  }): Promise<T> => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const value = await args.probe();
      if (value !== undefined) return value;
      await new Promise((resolve) => {
        return setTimeout(resolve, 25);
      });
    }
    throw new Error(`timed out waiting for ${args.describe}`);
  };

  type Fixture = {
    projectId: string;
    projectInternalId: number;
    aiProviderId: string;
    refundToolId: string;
    doneToolId: string;
    agentId: string;
  };

  const createTool = async (args: {
    projectId: string;
    name: string;
    guardrailIds?: string[];
    parameters?: Record<string, unknown>;
  }): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: args.projectId,
        name: args.name,
        type: 'http',
        description: `The ${args.name} tool`,
        ...(args.parameters ? { parameters: args.parameters } : {}),
        execute: { url: `${toolBaseUrl}/${args.name}`, method: 'POST' },
        ...(args.guardrailIds ? { guardrail_ids: args.guardrailIds } : {}),
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const createAgent = async (args: {
    fixture: Omit<Fixture, 'agentId'>;
    onApprovalExpiry?: string;
    gatedToolId?: string;
  }): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: args.fixture.projectId,
        ai_provider_id: args.fixture.aiProviderId,
        name: `routing agent ${fixtureCount}`,
        instructions: 'You must call the available tool to answer.',
        tool_bindings: [
          { tool_id: args.gatedToolId ?? args.fixture.refundToolId },
          { tool_id: args.fixture.doneToolId },
        ],
        tool_choice: 'required',
        stop_conditions: [{ type: 'has_tool_call', tool_name: DONE_TOOL }],
        max_steps: MAX_STEPS,
        ...(args.onApprovalExpiry
          ? { on_approval_expiry: args.onApprovalExpiry }
          : {}),
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  /**
   * A project whose refund tool is gated by a class-C guardrail, beside an
   * ungated `done` tool — the exit a forced turn reaches must not itself be
   * held — and a forcing agent bound to both.
   */
  const createFixture = async (
    args: { onApprovalExpiry?: string } = {}
  ): Promise<Fixture> => {
    fixtureCount += 1;
    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: `routing project ${fixtureCount}` });
    expect(projectRes.status).toBe(201);
    const projectId = projectRes.body.id as string;

    const providerRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: `routing provider ${fixtureCount}`,
        provider: 'ollama',
        default_model: 'stub-model',
        base_url: modelBaseUrl,
      });
    expect(providerRes.status).toBe(201);

    const guardrailRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/guardrails')
      .send({
        project_id: projectId,
        name: `routing-route-to-approval-${fixtureCount}`,
        document: { class: 'C' },
      });
    expect(guardrailRes.status).toBe(201);

    const refundToolId = await createTool({
      projectId,
      name: REFUND_TOOL,
      guardrailIds: [guardrailRes.body.id],
      parameters: {
        type: 'object',
        properties: { amount: { type: 'number' } },
        required: ['amount'],
      },
    });
    const doneToolId = await createTool({
      projectId,
      name: DONE_TOOL,
      parameters: { type: 'object', properties: {} },
    });

    const project = await db.Project.findOne({
      where: { publicId: projectId },
    });
    const base = {
      projectId,
      projectInternalId: project!.id as number,
      aiProviderId: providerRes.body.id as string,
      refundToolId,
      doneToolId,
    };
    return {
      ...base,
      agentId: await createAgent({
        fixture: base,
        onApprovalExpiry: args.onApprovalExpiry,
      }),
    };
  };

  const generate = async (
    agentId: string
  ): Promise<Record<string, unknown>> => {
    const res = await authenticatedTestClient(adminToken)
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'issue the refund' }] });
    expect(res.status).toBe(200);
    return res.body as Record<string, unknown>;
  };

  type Approval = {
    id: string;
    status: string;
    generation_id: string | null;
    agent_id: string | null;
    proposed_action: {
      tool_id: string;
      action: string;
      arguments: Record<string, unknown>;
    };
    reasoning: string | null;
    evidence: Record<string, unknown> | null;
    predicted_impact: string | null;
    expires_at: string;
    created_at: string;
  };

  const approvalsOf = async (args: {
    fixture: Fixture;
    status?: string;
  }): Promise<Approval[]> => {
    const res = await authenticatedTestClient(adminToken)
      .get('/api/v1/approvals')
      .query({
        project_id: args.fixture.projectId,
        ...(args.status ? { status: args.status } : {}),
      });
    expect(res.status).toBe(200);
    return res.body.data as Approval[];
  };

  type ListedGeneration = {
    id: string;
    status: string;
    stop_reason: string | null;
  };

  const getGeneration = async (id: string): Promise<ListedGeneration> => {
    const res = await authenticatedTestClient(adminToken).get(
      `/api/v1/generations/${id}`
    );
    expect(res.status).toBe(200);
    return res.body as ListedGeneration;
  };

  const continuationsOf = async (
    generationId: string
  ): Promise<ListedGeneration[]> => {
    const res = await authenticatedTestClient(adminToken)
      .get('/api/v1/generations')
      .query({ initiator_generation_id: generationId });
    expect(res.status).toBe(200);
    return res.body.data as ListedGeneration[];
  };

  /** Settled continuations of `generationId`, once there are `count` of them. */
  const settledContinuations = (args: {
    generationId: string;
    count: number;
  }): Promise<ListedGeneration[]> => {
    return waitFor({
      probe: async () => {
        const settled = (await continuationsOf(args.generationId)).filter(
          (generation) => {
            return generation.status === 'completed';
          }
        );
        return settled.length >= args.count ? settled : undefined;
      },
      describe: `${args.count} settled continuations of ${args.generationId}`,
    });
  };

  /**
   * Moves every held call's deadline into the past and drains the sweeper —
   * the ~24h a held call waits, without waiting it.
   */
  const expireHeldCalls = async (fixture: Fixture): Promise<void> => {
    await db.ApprovalItem.update(
      { expiresAt: new Date(Date.now() - 1000) },
      { where: { projectId: fixture.projectInternalId, status: 'pending' } }
    );
    let claimed = 0;
    do {
      claimed = await expireDueApprovals();
    } while (claimed > 0);
  };

  /** The tool definition one provider request offered under `name`. */
  const offeredTool = (body: Record<string, unknown>, name: string) => {
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const entry = tools.find((tool: { function?: { name?: string } }) => {
      return tool.function?.name === name;
    }) as { function: { parameters: Record<string, unknown> } } | undefined;
    return entry?.function.parameters;
  };

  /** The tool results the model was shown on a request, parsed. */
  const toolResultsIn = (
    body: Record<string, unknown>
  ): Array<Record<string, unknown>> => {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    return messages
      .filter((message: { role?: string }) => {
        return message.role === 'tool';
      })
      .map((message: { content?: unknown }) => {
        return JSON.parse(String(message.content)) as Record<string, unknown>;
      });
  };

  beforeAll(async () => {
    modelServer = createServer((req, res) => {
      void readJson(req).then((body) => {
        const request = body as Record<string, unknown>;
        modelRequests.push(request);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(completionFor(request)));
      });
    });
    modelBaseUrl = await listen(modelServer);

    toolServer = createServer((req, res) => {
      void readJson(req).then((body) => {
        toolRequests.push({
          url: req.url ?? '',
          body: body as Record<string, unknown>,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    toolBaseUrl = await listen(toolServer);

    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'routingadmin', password: 'supersecret' });
    adminToken = await loginAs('routingadmin', 'supersecret');
  });

  afterEach(() => {
    modelRequests = [];
    toolRequests = [];
    forcedToolName = REFUND_TOOL;
    nextArguments = () => {
      return { amount: proposalCount };
    };
  });

  afterAll(async () => {
    await close(modelServer);
    await close(toolServer);
  });

  describe('POST /api/v1/agents/{agent_id}/generate', () => {
    test('each gated call is held on its own approval and the turn ends on its step budget', async () => {
      const fixture = await createFixture();

      const result = await generate(fixture.agentId);

      expect(result.status).toBe('completed');
      expect(result.output).toMatchObject({ finish_reason: 'tool-calls' });
      expect(modelRequests).toHaveLength(MAX_STEPS);
      for (const body of modelRequests) {
        expect(body.tool_choice).toBe('required');
      }
      expect(toolRequests).toHaveLength(0);

      const pending = await approvalsOf({ fixture, status: 'pending' });
      expect(pending).toHaveLength(MAX_STEPS);
      for (const item of pending) {
        expect(item.generation_id).toBe(result.id);
        expect(item.agent_id).toBe(fixture.agentId);
        expect(item.proposed_action).toMatchObject({
          tool_id: fixture.refundToolId,
          action: REFUND_TOOL,
        });
        const ttlSeconds =
          (Date.parse(item.expires_at) - Date.parse(item.created_at)) / 1000;
        expect(Math.round(ttlSeconds)).toBe(
          DEFAULT_TOOL_APPROVAL_EXPIRES_IN_SECONDS
        );
      }
      expect(DEFAULT_TOOL_APPROVAL_EXPIRES_IN_SECONDS).toBe(24 * 60 * 60);

      // The second step was shown the first call's held result.
      expect(toolResultsIn(modelRequests[1])).toEqual([
        expect.objectContaining({
          status: 'pending_approval',
          approval_id: expect.stringMatching(/^apr_/),
        }),
      ]);
      const settled = await waitFor({
        probe: async () => {
          const row = await getGeneration(String(result.id));
          return row.stop_reason === 'max_steps' ? row : undefined;
        },
        describe: `generation ${String(result.id)} to record max_steps`,
      });
      expect(settled.status).toBe('completed');
    });

    test('a gated tool is offered the optional justification fields', async () => {
      const fixture = await createFixture();

      await generate(fixture.agentId);

      const parameters = offeredTool(modelRequests[0], REFUND_TOOL);
      expect(parameters).toMatchObject({
        type: 'object',
        required: ['amount'],
        properties: {
          amount: { type: 'number' },
          approval_reasoning: {
            type: 'string',
            description: expect.stringContaining(
              'This action requires human approval before it executes.'
            ),
          },
          approval_evidence: { type: 'object' },
          approval_predicted_impact: { type: 'string' },
        },
      });
      expect(offeredTool(modelRequests[0], DONE_TOOL)).not.toHaveProperty(
        'properties.approval_reasoning'
      );
    });

    test.each([
      { name: 'no parameters schema', parameters: undefined },
      {
        name: 'a schema declaring no properties',
        parameters: { type: 'object' },
      },
    ])(
      'a gated tool with $name is offered the justification fields',
      async ({ parameters }) => {
        const fixture = await createFixture();
        const guardrailIds = (
          await authenticatedTestClient(adminToken).get(
            `/api/v1/tools/${fixture.refundToolId}`
          )
        ).body.guardrail_ids as string[];
        const bareToolId = await createTool({
          projectId: fixture.projectId,
          name: 'routing-bare',
          guardrailIds,
          parameters,
        });
        const agentId = await createAgent({ fixture, gatedToolId: bareToolId });
        forcedToolName = 'routing-bare';

        await generate(agentId);

        expect(offeredTool(modelRequests[0], 'routing-bare')).toMatchObject({
          type: 'object',
          properties: {
            approval_reasoning: { type: 'string' },
            approval_evidence: { type: 'object' },
            approval_predicted_impact: { type: 'string' },
          },
        });
      }
    );

    test("a gated soat action is filed under the action's own name", async () => {
      const fixture = await createFixture();
      const guardrailIds = (
        await authenticatedTestClient(adminToken).get(
          `/api/v1/tools/${fixture.refundToolId}`
        )
      ).body.guardrail_ids as string[];
      const soatRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: fixture.projectId,
          name: 'platform',
          type: 'builtin',
          actions: ['list-tools'],
          guardrail_ids: guardrailIds,
        });
      expect(soatRes.status).toBe(201);
      const agentId = await createAgent({
        fixture,
        gatedToolId: soatRes.body.id,
      });
      forcedToolName = 'platform_list-tools';
      nextArguments = () => {
        return { limit: proposalCount };
      };

      await generate(agentId);

      const [item] = await approvalsOf({ fixture, status: 'pending' });
      expect(item.proposed_action).toMatchObject({
        tool_id: soatRes.body.id,
        action: 'list-tools',
      });
    });

    test('the justification is filed with the approval and stripped from the arguments', async () => {
      const fixture = await createFixture();
      nextArguments = () => {
        return {
          amount: proposalCount,
          approval_reasoning: 'over threshold',
          approval_evidence: { order_id: 'ord_1' },
          approval_predicted_impact: 'refunds one order',
        };
      };

      await generate(fixture.agentId);

      const [item] = await approvalsOf({ fixture, status: 'pending' });
      expect(item.reasoning).toBe('over threshold');
      expect(item.evidence).toEqual({ order_id: 'ord_1' });
      expect(item.predicted_impact).toBe('refunds one order');
      expect(Object.keys(item.proposed_action.arguments)).toEqual(['amount']);
    });

    test('a wrong-typed justification is filed as null', async () => {
      const fixture = await createFixture();
      nextArguments = () => {
        return {
          amount: proposalCount,
          approval_reasoning: 42,
          approval_evidence: 'not an object',
        };
      };

      await generate(fixture.agentId);

      const [item] = await approvalsOf({ fixture, status: 'pending' });
      expect(item.reasoning).toBeNull();
      expect(item.evidence).toBeNull();
      expect(item.predicted_impact).toBeNull();
      expect(Object.keys(item.proposed_action.arguments)).toEqual(['amount']);
    });

    test('re-proposing a held call joins its pending approval whatever the key order', async () => {
      const fixture = await createFixture();
      const orders = [
        { amount: 5, to: 'acct_1' },
        { to: 'acct_1', amount: 5 },
      ];
      nextArguments = () => {
        return orders[proposalCount % 2];
      };

      await generate(fixture.agentId);

      const pending = await approvalsOf({ fixture, status: 'pending' });
      expect(pending).toHaveLength(1);
      expect(toolResultsIn(modelRequests[1])).toEqual([
        expect.objectContaining({ approval_id: pending[0].id }),
      ]);
    });

    test('the same call from another agent is held on its own approval', async () => {
      const fixture = await createFixture();
      const otherAgentId = await createAgent({ fixture });
      nextArguments = () => {
        return { amount: 7 };
      };

      await generate(fixture.agentId);
      await generate(otherAgentId);

      const pending = await approvalsOf({ fixture, status: 'pending' });
      expect(
        pending
          .map((item) => {
            return item.agent_id;
          })
          .sort()
      ).toEqual([fixture.agentId, otherAgentId].sort());
    });
  });

  describe('expiry sweep', () => {
    test('a held call that expires ends the chain instead of spawning a continuation', async () => {
      const fixture = await createFixture();
      const seed = await generate(fixture.agentId);
      modelRequests = [];

      await expireHeldCalls(fixture);

      const items = await approvalsOf({ fixture });
      expect(
        items.map((item) => {
          return item.status;
        })
      ).toEqual(Array(MAX_STEPS).fill('expired'));
      const exception = await waitFor({
        probe: async () => {
          const res = await authenticatedTestClient(adminToken)
            .get('/api/v1/exceptions')
            .query({ project_id: fixture.projectId, kind: 'approval_expired' });
          expect(res.status).toBe(200);
          return res.body.data[0] as Record<string, unknown> | undefined;
        },
        describe: 'an approval_expired exception',
      });
      expect(exception.kind).toBe('approval_expired');
      // The resume is fire-and-forget and spawns nothing on this path, so the
      // assertion is that nothing appears for the whole window.
      for (let tick = 0; tick < 20; tick += 1) {
        expect(await continuationsOf(String(seed.id))).toHaveLength(0);
        await new Promise((resolve) => {
          return setTimeout(resolve, 25);
        });
      }
      expect(modelRequests).toHaveLength(0);
    });

    test('an agent that reacts to expiry is resumed, still forced, once per held call', async () => {
      const fixture = await createFixture({ onApprovalExpiry: 'react' });
      const seed = await generate(fixture.agentId);
      modelRequests = [];

      await expireHeldCalls(fixture);

      const continuations = await settledContinuations({
        generationId: String(seed.id),
        count: MAX_STEPS,
      });
      expect(continuations).toHaveLength(MAX_STEPS);
      for (const body of modelRequests) {
        expect(body.tool_choice).toBe('required');
      }
      // Each continuation can only propose more held calls, so the next round
      // is the square of this one; the step budget is what ends each turn.
      for (const continuation of continuations) {
        expect((await getGeneration(continuation.id)).stop_reason).toBe(
          'max_steps'
        );
      }
      expect(await approvalsOf({ fixture, status: 'pending' })).toHaveLength(
        MAX_STEPS * MAX_STEPS
      );
      expect(toolRequests).toHaveLength(0);
    });

    test('a declared terminal tool lets a forced continuation conclude', async () => {
      const fixture = await createFixture({ onApprovalExpiry: 'react' });
      const seed = await generate(fixture.agentId);
      forcedToolName = DONE_TOOL;

      await expireHeldCalls(fixture);

      const continuations = await settledContinuations({
        generationId: String(seed.id),
        count: MAX_STEPS,
      });
      for (const continuation of continuations) {
        expect((await getGeneration(continuation.id)).stop_reason).toBe(
          'tool-calls'
        );
      }
      expect(
        toolRequests.filter((request) => {
          return request.url === `/${DONE_TOOL}`;
        })
      ).toHaveLength(MAX_STEPS);
      expect(await approvalsOf({ fixture, status: 'pending' })).toHaveLength(0);
    });
  });
});
