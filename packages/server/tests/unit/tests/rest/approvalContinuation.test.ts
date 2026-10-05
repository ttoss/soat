import type http from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { db } from 'src/db';
import { emitApproval } from 'src/lib/approvals';
import { expireDueApprovals } from 'src/lib/approvalScheduler';
import { eventBus, type SoatEvent } from 'src/lib/eventBus';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * Resolving a `tool_call` approval resumes the agent that proposed the call:
 * the approved action runs, then a continuation generation — linked to the
 * proposing one through `initiator_generation_id` — tells the agent what was
 * decided. The expiry sweeper resumes an item the same way when nobody decides.
 *
 * Approvals have no public create endpoint, so items are seeded through
 * `emitApproval` and resolved through REST or the sweeper as in production. The
 * resume is fire-and-forget, so each test polls a bounded predicate on its own
 * side effect: a tool request, a continuation generation, or a model request.
 */
describe('Tool-call approval continuation', () => {
  let adminToken: string;
  let userToken: string;
  let userId: string;
  let projectId: string;
  let projectInternalId: number;
  let agentId: string;
  let reactingAgentId: string;
  let clientAgentId: string;
  let refundToolId: string;
  let clientToolId: string;

  let toolServer: http.Server;
  let modelServer: http.Server;
  const toolRequests: Array<Record<string, unknown>> = [];
  const toolRequestHeaders: http.IncomingHttpHeaders[] = [];
  const modelRequests: Array<Record<string, unknown>> = [];
  /**
   * What a turn resumed from a released client call refunds, so each test can
   * find its own tool request. The model calls the refund tool once on that
   * turn, which is what carries the turn's `tool_context` to a server tool.
   */
  let resumedRefundAmount = 0;

  const REFUND_TOOL = 'aprcont-refund';
  const CLIENT_TOOL = 'aprcont-write-file';

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

  const waitFor = async <T>(args: {
    probe: () => Promise<T | undefined> | T | undefined;
    describe: string;
  }): Promise<T> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const value = await args.probe();
      if (value !== undefined) return value;
      await new Promise((resolve) => {
        return setTimeout(resolve, 25);
      });
    }
    throw new Error(`timed out waiting for ${args.describe}`);
  };

  type ChatMessage = {
    role?: string;
    content?: unknown;
    tool_calls?: Array<{ function?: { name?: string } }>;
  };

  /**
   * Answers in text, except on a turn resumed from a released client call: there
   * it calls the refund tool once before answering.
   */
  const completionFor = (body: Record<string, unknown>) => {
    const messages: ChatMessage[] = Array.isArray(body.messages)
      ? body.messages
      : [];
    const resumedFromClientCall = messages.some((message) => {
      return (
        typeof message.content === 'string' &&
        message.content.includes('released to the client for execution')
      );
    });
    const refunded = messages.some((message) => {
      return (message.tool_calls ?? []).some((call) => {
        return call.function?.name === REFUND_TOOL;
      });
    });
    const callsRefund =
      resumedFromClientCall && messages.at(-1)?.role === 'tool' && !refunded;
    const message = callsRefund
      ? {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_aprcont_refund',
              type: 'function',
              function: {
                name: REFUND_TOOL,
                arguments: JSON.stringify({ amount: resumedRefundAmount }),
              },
            },
          ],
        }
      : { role: 'assistant', content: 'acknowledged' };
    return {
      id: 'chatcmpl-aprcont',
      object: 'chat.completion',
      created: 0,
      model: 'stub-model',
      choices: [
        {
          index: 0,
          message,
          finish_reason: callsRefund ? 'tool_calls' : 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  };

  /** The text of every user message one provider request carried. */
  const userTextOf = (body: Record<string, unknown>): string => {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    return messages
      .filter((message: { role?: string }) => {
        return message.role === 'user';
      })
      .map((message: { content?: unknown }) => {
        return typeof message.content === 'string'
          ? message.content
          : JSON.stringify(message.content);
      })
      .join('\n');
  };

  /** The continuation turn's opening message, once the provider receives it. */
  const continuationMessageFor = (approvalId: string): Promise<string> => {
    return waitFor({
      probe: () => {
        return modelRequests.map(userTextOf).find((text) => {
          return text.includes(`Approval ${approvalId} `);
        });
      },
      describe: `the continuation message for ${approvalId}`,
    });
  };

  const toolRequestWith = (amount: number) => {
    return waitFor({
      probe: () => {
        return toolRequests.find((body) => {
          return body.amount === amount;
        });
      },
      describe: `a tool request with amount ${amount}`,
    });
  };

  type ListedGeneration = {
    id: string;
    status: string;
    session_id: string | null;
    initiator_generation_id: string | null;
    started_by_principal_type: string | null;
    started_by_principal_id: string | null;
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

  const firstContinuationOf = (
    generationId: string
  ): Promise<ListedGeneration> => {
    return waitFor({
      probe: async () => {
        return (await continuationsOf(generationId))[0];
      },
      describe: `a continuation of ${generationId}`,
    });
  };

  /** A completed turn of `agent`, run by the project user. */
  const rootGeneration = async (agent: string): Promise<string> => {
    const res = await authenticatedTestClient(userToken)
      .post(`/api/v1/agents/${agent}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'refund my order' }] });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    return res.body.id as string;
  };

  const seed = (args: {
    toolId: string;
    action?: string;
    arguments?: Record<string, unknown>;
    amount?: number;
    generationId?: string;
    sessionId?: string;
    agentId?: string | null;
    expiresInSeconds?: number;
  }) => {
    return emitApproval({
      projectId: projectInternalId,
      origin: 'tool_call',
      proposedAction: {
        toolId: args.toolId,
        action: args.action ?? 'refund',
        arguments: args.arguments ?? { amount: args.amount ?? 0 },
      },
      expiresInSeconds: args.expiresInSeconds ?? 3600,
      generationId: args.generationId,
      sessionId: args.sessionId,
      agentId: args.agentId === undefined ? agentId : args.agentId,
    });
  };

  const approve = (approvalId: string, body: Record<string, unknown> = {}) => {
    return authenticatedTestClient(adminToken)
      .post(`/api/v1/approvals/${approvalId}/approve`)
      .send(body);
  };

  /** Drains every due item, the way the scheduler's tick does. */
  const sweep = async (): Promise<void> => {
    let claimed = 0;
    do {
      claimed = await expireDueApprovals();
    } while (claimed > 0);
  };

  const createAgent = async (args: {
    aiProviderId: string;
    name: string;
    onApprovalExpiry?: string;
    toolIds?: string[];
  }): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: args.aiProviderId,
        name: args.name,
        ...(args.onApprovalExpiry
          ? { on_approval_expiry: args.onApprovalExpiry }
          : {}),
        ...(args.toolIds
          ? {
              tool_bindings: args.toolIds.map((toolId) => {
                return { tool_id: toolId };
              }),
            }
          : {}),
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'aprcont',
      policyActions: ['agents:CreateAgentGeneration'],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    userId = setup.userId;
    projectId = setup.projectId;
    const project = await db.Project.findOne({
      where: { publicId: projectId },
    });
    projectInternalId = project!.id as number;

    toolServer = createServer((req, res) => {
      void readJson(req).then((body) => {
        toolRequests.push(body as Record<string, unknown>);
        toolRequestHeaders.push(req.headers);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    const toolBaseUrl = await listen(toolServer);

    modelServer = createServer((req, res) => {
      void readJson(req).then((body) => {
        const request = body as Record<string, unknown>;
        modelRequests.push(request);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(completionFor(request)));
      });
    });
    const modelBaseUrl = await listen(modelServer);

    const providerRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'aprcont-provider',
        provider: 'ollama',
        default_model: 'stub-model',
        base_url: modelBaseUrl,
      });
    expect(providerRes.status).toBe(201);

    const toolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: REFUND_TOOL,
        type: 'http',
        description: 'Issue a refund',
        parameters: {
          type: 'object',
          properties: { amount: { type: 'number' } },
        },
        execute: { url: `${toolBaseUrl}/refund`, method: 'POST' },
      });
    expect(toolRes.status).toBe(201);
    refundToolId = toolRes.body.id as string;

    const clientToolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: CLIENT_TOOL,
        type: 'client',
        description: 'Write a file on the caller machine',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
        },
      });
    expect(clientToolRes.status).toBe(201);
    clientToolId = clientToolRes.body.id as string;

    agentId = await createAgent({
      aiProviderId: providerRes.body.id,
      name: 'aprcont-agent',
    });
    reactingAgentId = await createAgent({
      aiProviderId: providerRes.body.id,
      name: 'aprcont-reacting-agent',
      onApprovalExpiry: 'react',
    });
    clientAgentId = await createAgent({
      aiProviderId: providerRes.body.id,
      name: 'aprcont-client-agent',
      toolIds: [clientToolId, refundToolId],
    });
  });

  afterAll(async () => {
    await close(toolServer);
    await close(modelServer);
  });

  describe('POST /api/v1/approvals/{approval_id}/approve', () => {
    test('runs the approved action and continues the proposing generation', async () => {
      const root = await rootGeneration(agentId);
      const item = await seed({
        toolId: refundToolId,
        amount: 25,
        generationId: root,
      });

      const res = await approve(item.id);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('approved');

      expect(await toolRequestWith(25)).toEqual({ amount: 25 });
      const message = await continuationMessageFor(item.id);
      expect(message).toContain(
        `Approval ${item.id} for your proposed call to tool ${refundToolId} (refund) was approved.`
      );
      expect(message).toContain(
        'The action has been executed. Result: {"ok":true}.'
      );

      const continuation = await firstContinuationOf(root);
      expect(continuation.initiator_generation_id).toBe(root);
    });

    test('the continuation runs as the principal that started the chain, not the approver', async () => {
      const root = await rootGeneration(agentId);
      const item = await seed({
        toolId: refundToolId,
        amount: 26,
        generationId: root,
      });

      expect((await approve(item.id)).status).toBe(200);

      const continuation = await firstContinuationOf(root);
      expect(continuation.started_by_principal_type).toBe('user');
      expect(continuation.started_by_principal_id).toBe(userId);
    });

    test('edited arguments are what runs, and the continuation names them', async () => {
      const root = await rootGeneration(agentId);
      const item = await seed({
        toolId: refundToolId,
        amount: 27,
        generationId: root,
      });

      expect(
        (await approve(item.id, { arguments: { amount: 9 } })).status
      ).toBe(200);

      expect(await toolRequestWith(9)).toEqual({ amount: 9 });
      expect(await continuationMessageFor(item.id)).toContain(
        'It was approved with edited arguments: {"amount":9}.'
      );
    });

    test('a failed action is reported to the continuation as its result', async () => {
      const root = await rootGeneration(agentId);
      const item = await seed({
        toolId: 'tool_aprcontmissing0000',
        generationId: root,
      });

      expect((await approve(item.id)).status).toBe(200);

      const message = await continuationMessageFor(item.id);
      expect(message).toContain(
        'The action has been executed. Result: {"error":'
      );
      expect(message).toContain('tool_aprcontmissing0000');
    });

    test('a proposing generation that no longer exists still runs the action', async () => {
      const item = await seed({
        toolId: refundToolId,
        amount: 28,
        generationId: 'gen_aprcontmissing00000',
      });

      const res = await approve(item.id);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('approved');
      expect(await toolRequestWith(28)).toEqual({ amount: 28 });
    });

    test('a proposing agent that no longer exists still resolves the item', async () => {
      const item = await seed({
        toolId: refundToolId,
        amount: 29,
        agentId: 'agent_aprcontdeleted000',
      });

      const res = await approve(item.id);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('approved');
      expect(await toolRequestWith(29)).toEqual({ amount: 29 });
    });

    test('a session-backed item continues in its session', async () => {
      const sessionRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/sessions')
        .send({ agent_id: agentId });
      expect(sessionRes.status).toBe(201);
      const sessionId = sessionRes.body.id as string;
      const root = await rootGeneration(agentId);
      const item = await seed({
        toolId: refundToolId,
        amount: 30,
        generationId: root,
        sessionId,
      });

      expect((await approve(item.id)).status).toBe(200);

      expect(await toolRequestWith(30)).toEqual({ amount: 30 });
      const continuation = await firstContinuationOf(root);
      expect(continuation.session_id).toBe(sessionId);
      expect(await continuationMessageFor(item.id)).toContain('was approved.');
    });
  });

  describe('POST /api/v1/approvals/{approval_id}/reject', () => {
    test('continues without running the action, carrying the reason', async () => {
      const root = await rootGeneration(agentId);
      const item = await seed({
        toolId: refundToolId,
        amount: 31,
        generationId: root,
      });

      const res = await authenticatedTestClient(adminToken)
        .post(`/api/v1/approvals/${item.id}/reject`)
        .send({ reason: 'over budget' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('rejected');

      expect(await continuationMessageFor(item.id)).toContain(
        'was rejected. Nothing was executed. Reason: over budget.'
      );
      await firstContinuationOf(root);
      expect(
        toolRequests.some((body) => {
          return body.amount === 31;
        })
      ).toBe(false);
    });
  });

  describe('expiry sweep', () => {
    test('an agent that reacts to expiry is told the call lapsed', async () => {
      const root = await rootGeneration(reactingAgentId);
      const item = await seed({
        toolId: refundToolId,
        amount: 32,
        generationId: root,
        agentId: reactingAgentId,
        expiresInSeconds: -10,
      });

      await sweep();

      expect(await continuationMessageFor(item.id)).toContain(
        'was expired. It expired before a human decided, so nothing was executed.'
      );
      const continuation = await firstContinuationOf(root);
      expect(continuation.initiator_generation_id).toBe(root);
      expect(
        toolRequests.some((body) => {
          return body.amount === 32;
        })
      ).toBe(false);
    });

    test('an expiry with no agent to report to ends the item without a continuation', async () => {
      const item = await seed({
        toolId: refundToolId,
        amount: 33,
        agentId: null,
        expiresInSeconds: -10,
      });

      await sweep();

      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/approvals/${item.id}`
      );
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('expired');
    });

    test('an expiry of an agent that does not react ends the item without a continuation', async () => {
      const item = await seed({
        toolId: refundToolId,
        amount: 34,
        expiresInSeconds: -10,
      });

      await sweep();

      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/approvals/${item.id}`
      );
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('expired');
    });
  });

  describe('POST /api/v1/approvals/{approval_id}/approve — client tools', () => {
    type ReleasedCall = {
      generationId: string;
      toolCallId: string;
      args: Record<string, unknown>;
    };

    /**
     * Approves a client-tool item and answers the call the platform releases
     * back to the client, read off `agents.generation.requires_action` — the
     * event a client is told through.
     */
    const approveAndCaptureRelease = async (args: {
      approvalId: string;
      body?: Record<string, unknown>;
    }): Promise<ReleasedCall> => {
      const released: ReleasedCall[] = [];
      const handler = (event: SoatEvent) => {
        if (event.type !== 'agents.generation.requires_action') return;
        const requiredAction = event.data.requiredAction as {
          toolCalls: Array<{
            id: string;
            toolName: string;
            args: Record<string, unknown>;
          }>;
        };
        for (const call of requiredAction.toolCalls) {
          if (call.toolName !== CLIENT_TOOL) continue;
          released.push({
            generationId: event.resourceId,
            toolCallId: call.id,
            args: call.args,
          });
        }
      };
      eventBus.on('soat:event', handler);
      try {
        const res = await approve(args.approvalId, args.body);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('approved');
        return await waitFor({
          probe: () => {
            return released[0];
          },
          describe: `the client call released by ${args.approvalId}`,
        });
      } finally {
        eventBus.off('soat:event', handler);
      }
    };

    const submitOutput = (call: ReleasedCall) => {
      return authenticatedTestClient(adminToken)
        .post(
          `/api/v1/agents/${clientAgentId}/generate/${call.generationId}/tool-outputs`
        )
        .send({
          tool_outputs: [{ tool_call_id: call.toolCallId, output: 'written' }],
        });
    };

    const seedClientCall = (args: {
      generationId: string;
      path: string;
      sessionId?: string;
    }) => {
      return seed({
        toolId: clientToolId,
        action: CLIENT_TOOL,
        arguments: { path: args.path },
        generationId: args.generationId,
        sessionId: args.sessionId,
        agentId: clientAgentId,
      });
    };

    test('hands the approved call back to the client on a linked generation', async () => {
      const root = await rootGeneration(clientAgentId);
      const item = await seedClientCall({
        generationId: root,
        path: '/etc/frozen',
      });

      const call = await approveAndCaptureRelease({ approvalId: item.id });

      expect(call.args).toEqual({ path: '/etc/frozen' });
      const [continuation] = await continuationsOf(root);
      expect(continuation.id).toBe(call.generationId);
      expect(continuation.status).toBe('requires_action');
      expect(
        toolRequests.some((body) => {
          return body.path === '/etc/frozen';
        })
      ).toBe(false);
    });

    test('the client resumes the released call by submitting its output', async () => {
      resumedRefundAmount = 41;
      const root = await rootGeneration(clientAgentId);
      const item = await seedClientCall({
        generationId: root,
        path: '/etc/resume',
      });
      const call = await approveAndCaptureRelease({ approvalId: item.id });

      const res = await submitOutput(call);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      const resumed = modelRequests.map(userTextOf).find((text) => {
        return text.includes(`(approval ${item.id})`);
      });
      expect(resumed).toContain(
        `Your proposed call to the client tool \`${CLIENT_TOOL}\` was approved`
      );
    });

    test('edited arguments replace the proposal in the released call', async () => {
      const root = await rootGeneration(clientAgentId);
      const item = await seedClientCall({
        generationId: root,
        path: '/etc/frozen',
      });

      const call = await approveAndCaptureRelease({
        approvalId: item.id,
        body: { arguments: { path: '/tmp/edited' } },
      });

      expect(call.args).toEqual({ path: '/tmp/edited' });
    });

    test("the approver's tool_context and the session ride the released call", async () => {
      resumedRefundAmount = 42;
      const sessionRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/sessions')
        .send({ agent_id: clientAgentId });
      expect(sessionRes.status).toBe(201);
      const sessionId = sessionRes.body.id as string;
      const root = await rootGeneration(clientAgentId);
      const item = await seedClientCall({
        generationId: root,
        path: '/etc/context',
        sessionId,
      });

      const call = await approveAndCaptureRelease({
        approvalId: item.id,
        body: { tool_context: { turn_token: 'fresh-456' } },
      });
      const [continuation] = await continuationsOf(root);
      expect(continuation.session_id).toBe(sessionId);

      expect((await submitOutput(call)).status).toBe(200);
      await toolRequestWith(42);
      const headers =
        toolRequestHeaders[
          toolRequests.findIndex((body) => {
            return body.amount === 42;
          })
        ];
      expect(headers['x-soat-context-turn_token']).toBe('fresh-456');
    });

    test('a session deleted while the call waited leaves the release unattributed', async () => {
      const sessionRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/sessions')
        .send({ agent_id: clientAgentId });
      expect(sessionRes.status).toBe(201);
      const sessionId = sessionRes.body.id as string;
      const root = await rootGeneration(clientAgentId);
      const item = await seedClientCall({
        generationId: root,
        path: '/etc/orphaned',
        sessionId,
      });
      const deleted = await authenticatedTestClient(adminToken).delete(
        `/api/v1/sessions/${sessionId}`
      );
      expect(deleted.status).toBe(204);

      const call = await approveAndCaptureRelease({ approvalId: item.id });

      expect(call.args).toEqual({ path: '/etc/orphaned' });
      const [continuation] = await continuationsOf(root);
      expect(continuation.id).toBe(call.generationId);
      expect(continuation.session_id).toBeNull();
    });

    test("the approver's tool_context rides a released call outside a session", async () => {
      resumedRefundAmount = 43;
      const root = await rootGeneration(clientAgentId);
      const item = await seedClientCall({
        generationId: root,
        path: '/etc/no-session',
      });

      const call = await approveAndCaptureRelease({
        approvalId: item.id,
        body: { tool_context: { turn_token: 'fresh-789' } },
      });
      expect((await submitOutput(call)).status).toBe(200);

      await toolRequestWith(43);
      const headers =
        toolRequestHeaders[
          toolRequests.findIndex((body) => {
            return body.amount === 43;
          })
        ];
      expect(headers['x-soat-context-turn_token']).toBe('fresh-789');
    });
  });
});
