import type http from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { db } from 'src/db';
import { emitApproval } from 'src/lib/approvals';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * `tool_context` on `POST /approvals/:id/approve`.
 *
 * A caller whose tools authorize through `tool_context` (a per-turn credential
 * forwarded as a context header) has nothing on the approval to re-supply it
 * from: the bag is never persisted, and the turn's credential may have expired
 * by the time a human decides. The approver hands a fresh bag in, and both the
 * approved action and the continuation turn's own tool calls carry it.
 *
 * Approvals have no public create endpoint, so items are seeded through
 * `emitApproval` and resolved through REST as a real client would.
 */
describe('POST /api/v1/approvals/:approval_id/approve — tool_context', () => {
  let adminToken: string;
  let noPermToken: string;
  let projectId: string;
  let projectInternalId: number;
  let agentId: string;
  let httpToolId: string;

  let toolServer: http.Server;
  let modelServer: http.Server;
  let toolRequests: http.IncomingHttpHeaders[] = [];

  const TOOL_NAME = 'approvalctx-refund';

  /** The continuation turn calls the tool once, then answers. */
  const completionFor = (body: Record<string, unknown>) => {
    const answered = (body.messages as { role: string }[]).some((message) => {
      return message.role === 'tool';
    });
    const message = answered
      ? { role: 'assistant', content: 'done' }
      : {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_approvalctx',
              type: 'function',
              function: {
                name: TOOL_NAME,
                arguments: JSON.stringify({ amount: 1 }),
              },
            },
          ],
        };
    return {
      id: 'chatcmpl-approvalctx',
      object: 'chat.completion',
      created: 0,
      model: 'stub-model',
      choices: [
        {
          index: 0,
          message,
          finish_reason: answered ? 'stop' : 'tool_calls',
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

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'approvalctx',
      policyActions: ['approvals:ResolveApproval'],
    });
    adminToken = setup.adminToken;
    noPermToken = setup.noPermToken as string;
    projectId = setup.projectId;
    const project = await db.Project.findOne({
      where: { publicId: projectId },
    });
    projectInternalId = project!.id as number;

    toolServer = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        toolRequests.push(req.headers);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    const toolBaseUrl = await listen(toolServer);

    modelServer = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(completionFor(body)));
      });
    });
    const modelBaseUrl = await listen(modelServer);

    const providerRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'approvalctx-provider',
        provider: 'ollama',
        default_model: 'stub-model',
        base_url: modelBaseUrl,
      });
    expect(providerRes.status).toBe(201);

    const toolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: TOOL_NAME,
        type: 'http',
        description: 'Issue a refund',
        parameters: {
          type: 'object',
          properties: { amount: { type: 'number' } },
        },
        execute: { url: `${toolBaseUrl}/refund`, method: 'POST' },
      });
    expect(toolRes.status).toBe(201);
    httpToolId = toolRes.body.id as string;

    const agentRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: providerRes.body.id,
        name: 'approvalctx-agent',
        tool_bindings: [{ tool_id: httpToolId }],
      });
    expect(agentRes.status).toBe(201);
    agentId = agentRes.body.id as string;
  });

  afterAll(async () => {
    await close(toolServer);
    await close(modelServer);
  });

  beforeEach(() => {
    toolRequests = [];
  });

  const seed = async () => {
    return emitApproval({
      projectId: projectInternalId,
      origin: 'tool_call',
      proposedAction: { toolId: httpToolId, arguments: { amount: 5 } },
      expiresInSeconds: 3600,
      agentId,
    });
  };

  /**
   * The resolve route fires the continuation and forgets it, so poll. Every
   * approval here makes two calls (the approved action, then the
   * continuation's), and waiting for both keeps one test's late call out of
   * the next.
   */
  const waitForToolRequests = async (count: number) => {
    for (let i = 0; i < 120 && toolRequests.length < count; i += 1) {
      await new Promise((resolve) => {
        return setTimeout(resolve, 25);
      });
    }
    return toolRequests;
  };

  test('the approved action and the continuation turn carry the bag', async () => {
    const item = await seed();

    const res = await authenticatedTestClient(adminToken)
      .post(`/api/v1/approvals/${item.id}/approve`)
      .send({ tool_context: { turn_token: 'fresh-123' } });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');

    const [approved, continued] = await waitForToolRequests(2);
    expect(approved?.['x-soat-context-turn_token']).toBe('fresh-123');
    expect(continued?.['x-soat-context-turn_token']).toBe('fresh-123');
  });

  test('the approver cannot assert a server-pinned identity key', async () => {
    const item = await seed();

    const res = await authenticatedTestClient(adminToken)
      .post(`/api/v1/approvals/${item.id}/approve`)
      .send({
        tool_context: {
          turn_token: 'fresh-789',
          session_id: 'sess_forged',
          actor_id: 'act_forged',
        },
      });
    expect(res.status).toBe(200);

    const [approved] = await waitForToolRequests(2);
    expect(approved?.['x-soat-context-turn_token']).toBe('fresh-789');
    expect(approved?.['x-soat-context-session_id']).toBeUndefined();
    expect(approved?.['x-soat-context-actor_id']).toBeUndefined();
  });

  test('the bag is never stored on the item', async () => {
    const item = await seed();

    await authenticatedTestClient(adminToken)
      .post(`/api/v1/approvals/${item.id}/approve`)
      .send({ tool_context: { turn_token: 'secret-value' } });
    await waitForToolRequests(2);

    const row = await db.ApprovalItem.findOne({
      where: { publicId: item.id },
    });
    expect(JSON.stringify(row!.toJSON())).not.toContain('secret-value');
  });

  test('without a bag, nothing is forwarded', async () => {
    const item = await seed();

    const res = await authenticatedTestClient(adminToken).post(
      `/api/v1/approvals/${item.id}/approve`
    );
    expect(res.status).toBe(200);

    const [approved] = await waitForToolRequests(2);
    expect(approved?.['x-soat-context-turn_token']).toBeUndefined();
  });

  test('a key that cannot be a header name is refused and nothing is resolved', async () => {
    const item = await seed();

    const res = await authenticatedTestClient(adminToken)
      .post(`/api/v1/approvals/${item.id}/approve`)
      .send({ tool_context: { 'not a header': 'x' } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_TOOL_CONTEXT_KEY');

    const row = await db.ApprovalItem.findOne({
      where: { publicId: item.id },
    });
    expect(row!.status).toBe('pending');
    expect(toolRequests).toHaveLength(0);
  });

  test('user without permission returns 403', async () => {
    const item = await seed();

    const res = await authenticatedTestClient(noPermToken)
      .post(`/api/v1/approvals/${item.id}/approve`)
      .send({ tool_context: { turn_token: 'x' } });
    expect(res.status).toBe(403);
  });
});
