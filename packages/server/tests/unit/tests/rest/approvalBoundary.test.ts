import type http from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { db } from 'src/db';
import { emitApproval } from 'src/lib/approvals';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * An approved `builtin` action runs outside the generation that proposed it,
 * so the proposing agent's `boundary_policy` is checked again where it runs.
 * The continuation's opening message carries the action's result, which is
 * how these tests read what ran.
 */
describe("an approved builtin action is held to the agent's boundary", () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let projectInternalId: number;
  let builtinToolId: string;
  let memoryStoreId: string;
  let openAgentId: string;
  let boundedAgentId: string;

  let modelServer: http.Server;
  const modelRequests: Array<Record<string, unknown>> = [];

  const listen = async (server: http.Server): Promise<string> => {
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

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

  const continuationMessageFor = async (approvalId: string) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const text = modelRequests.map(userTextOf).find((candidate) => {
        return candidate.includes(`Approval ${approvalId} `);
      });
      if (text) return text;
      await new Promise((resolve) => {
        return setTimeout(resolve, 25);
      });
    }
    throw new Error(`no continuation for ${approvalId}`);
  };

  const createAgent = async (args: {
    aiProviderId: string;
    name: string;
    boundaryPolicy?: object;
  }): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: args.aiProviderId,
        name: args.name,
        ...(args.boundaryPolicy
          ? { boundary_policy: args.boundaryPolicy }
          : {}),
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const approveGetMemoryStore = async (agentId: string): Promise<string> => {
    const root = await authenticatedTestClient(userToken)
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'read the store' }] });
    expect(root.status).toBe(200);

    const item = await emitApproval({
      projectId: projectInternalId,
      origin: 'tool_call',
      proposedAction: {
        toolId: builtinToolId,
        action: 'get-memory-store',
        arguments: { memory_store_id: memoryStoreId },
      },
      expiresInSeconds: 3600,
      generationId: root.body.id as string,
      agentId,
    });

    const res = await authenticatedTestClient(adminToken)
      .post(`/api/v1/approvals/${item.id}/approve`)
      .send({});
    expect(res.status).toBe(200);
    return continuationMessageFor(item.id);
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'aprbound',
      policyActions: [
        'agents:CreateAgentGeneration',
        'memories:GetMemoryStore',
      ],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;
    const project = await db.Project.findOne({
      where: { publicId: projectId },
    });
    projectInternalId = project!.id as number;

    modelServer = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        modelRequests.push(JSON.parse(raw) as Record<string, unknown>);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-aprbound',
            object: 'chat.completion',
            created: 0,
            model: 'stub-model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'acknowledged' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        );
      });
    });
    const modelBaseUrl = await listen(modelServer);

    const providerRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'aprbound-provider',
        provider: 'ollama',
        default_model: 'stub-model',
        base_url: modelBaseUrl,
      });
    expect(providerRes.status).toBe(201);

    const storeRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/memory-stores')
      .send({ project_id: projectId, name: 'aprbound-store' });
    expect(storeRes.status).toBe(201);
    memoryStoreId = storeRes.body.id as string;

    const toolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'aprbound-platform',
        type: 'builtin',
        actions: ['get-memory-store'],
      });
    expect(toolRes.status).toBe(201);
    builtinToolId = toolRes.body.id as string;

    openAgentId = await createAgent({
      aiProviderId: providerRes.body.id,
      name: 'aprbound-open',
    });
    boundedAgentId = await createAgent({
      aiProviderId: providerRes.body.id,
      name: 'aprbound-bounded',
      boundaryPolicy: {
        statement: [
          {
            effect: 'Allow',
            action: ['memories:ListMemoryStores'],
            resource: ['*'],
          },
        ],
      },
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      modelServer.close(() => {
        return resolve();
      });
    });
  });

  test('an agent with no boundary runs the action', async () => {
    const message = await approveGetMemoryStore(openAgentId);

    expect(message).toContain(`"id":"${memoryStoreId}"`);
  });

  test('a boundary that denies the action refuses it', async () => {
    const message = await approveGetMemoryStore(boundedAgentId);

    expect(message).toContain(
      'Result: {"error":"Forbidden: boundary policy denies memories:GetMemoryStore"}'
    );
    expect(message).not.toContain(`"id":"${memoryStoreId}"`);
  });
});
