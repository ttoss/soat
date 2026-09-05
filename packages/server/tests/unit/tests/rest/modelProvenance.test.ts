import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * Provenance of a model value: the generate result and the `model` usage
 * rollup both name the AI provider that served the string.
 *
 * Two providers serve the *same* model name here on purpose — the collision a
 * gateway in front of SOAT hits when a tenant registers their own credential
 * for a vendor SOAT also resells. Without `ai_provider_id` the two are one
 * indistinguishable bucket, and the string cannot be translated back safely.
 */
describe('Model provenance', () => {
  let userToken: string;
  let adminToken: string;
  let projectId: string;
  let firstProviderId: string;
  let secondProviderId: string;
  let firstAgentId: string;
  let secondAgentId: string;
  let stubServer: Server;

  const startStubServer = async (): Promise<string> => {
    stubServer = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-provenance',
            object: 'chat.completion',
            created: 0,
            model: 'stub-model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'served' },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 20,
              total_tokens: 30,
            },
          })
        );
      });
    });
    await new Promise<void>((resolve) => {
      stubServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = stubServer.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  const createProvider = async (args: {
    name: string;
    baseUrl: string;
  }): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: args.name,
        provider: 'ollama',
        default_model: 'stub-model',
        base_url: args.baseUrl,
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const createAgent = async (args: {
    name: string;
    aiProviderId: string;
  }): Promise<string> => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/agents')
      .send({
        ai_provider_id: args.aiProviderId,
        project_id: projectId,
        name: args.name,
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  beforeAll(async () => {
    const stubBaseUrl = await startStubServer();

    const setup = await setupProjectWithUsers({
      prefix: 'modelprov',
      policyActions: [
        'agents:CreateAgent',
        'agents:CreateAgentGeneration',
        'usage:GetUsage',
      ],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;

    firstProviderId = await createProvider({
      name: 'Provenance Provider A',
      baseUrl: stubBaseUrl,
    });
    secondProviderId = await createProvider({
      name: 'Provenance Provider B',
      baseUrl: stubBaseUrl,
    });

    firstAgentId = await createAgent({
      name: 'Provenance Agent A',
      aiProviderId: firstProviderId,
    });
    secondAgentId = await createAgent({
      name: 'Provenance Agent B',
      aiProviderId: secondProviderId,
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      stubServer.close(() => {
        resolve();
      });
    });
  });

  test('a generate result names the provider that served the model', async () => {
    const first = await authenticatedTestClient(userToken)
      .post(`/api/v1/agents/${firstAgentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'hello' }] });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('completed');
    expect(first.body.output.model).toBe('stub-model');
    expect(first.body.ai_provider_id).toBe(firstProviderId);

    const second = await authenticatedTestClient(userToken)
      .post(`/api/v1/agents/${secondAgentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'hello' }] });
    expect(second.status).toBe(200);
    expect(second.body.ai_provider_id).toBe(secondProviderId);
  });

  test('the model rollup splits one model name per serving provider', async () => {
    const res = await authenticatedTestClient(userToken).get(
      `/api/v1/usage?project_id=${projectId}&group_by=model`
    );
    expect(res.status).toBe(200);

    const stubGroups = res.body.groups.data.filter((g: { key: string }) => {
      return g.key === 'stub-model';
    });
    expect(stubGroups).toHaveLength(2);
    expect(
      stubGroups
        .map((g: { ai_provider_id: string }) => {
          return g.ai_provider_id;
        })
        .sort()
    ).toEqual([firstProviderId, secondProviderId].sort());

    // Splitting the bucket keeps the rollup additive: the groups still sum to
    // the grand total.
    const summed = stubGroups.reduce(
      (acc: number, g: { input_tokens: number }) => {
        return acc + g.input_tokens;
      },
      0
    );
    expect(res.body.totals.input_tokens).toBe(summed);
  });

  test('groups by ai_provider', async () => {
    const res = await authenticatedTestClient(userToken).get(
      `/api/v1/usage?project_id=${projectId}&group_by=ai_provider`
    );
    expect(res.status).toBe(200);
    expect(res.body.group_by).toBe('ai_provider');
    expect(
      res.body.groups.data
        .map((g: { key: string }) => {
          return g.key;
        })
        .sort()
    ).toEqual([firstProviderId, secondProviderId].sort());
  });

  test('a dimension other than model carries a null provider', async () => {
    const res = await authenticatedTestClient(userToken).get(
      `/api/v1/usage?project_id=${projectId}&group_by=agent`
    );
    expect(res.status).toBe(200);
    expect(res.body.groups.data.length).toBeGreaterThan(0);
    for (const group of res.body.groups.data) {
      expect(group.ai_provider_id).toBeNull();
    }
  });
});
