import type { Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createProjectPolicy } from '../../fixtures/bootstrap';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

const VENDOR_DETAIL = 'vendor-secret-detail';

const STREAM_MESSAGE = {
  id: 'msg_stub',
  type: 'message',
  role: 'assistant',
  model: 'claude-shared-test',
  content: [],
  stop_reason: null,
  stop_sequence: null,
  usage: { input_tokens: 4, output_tokens: 0 },
};

/**
 * A provider project P shares with project Q: Q's agents, routes and chats
 * generate through it on P's credential, metered in Q at P's prices, and Q
 * sees only its projection.
 */
describe('Shared AI providers', () => {
  let providerStub: Server;
  let failing = false;
  let streamFailing = false;
  let adminToken: string;
  let publisherId: string;
  let granteeId: string;
  let granteeKey: string;
  let sharedProviderId: string;
  let shareId: string;

  const startProviderStub = async (): Promise<string> => {
    providerStub = createServer((req, res: ServerResponse) => {
      req.resume();
      req.on('end', () => {
        if (failing) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              type: 'error',
              error: { type: 'invalid_request_error', message: VENDOR_DETAIL },
            })
          );
          return;
        }
        if (streamFailing) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end(
            [
              { type: 'message_start', message: STREAM_MESSAGE },
              {
                type: 'error',
                error: { type: 'overloaded_error', message: VENDOR_DETAIL },
              },
            ]
              .map((event) => {
                return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
              })
              .join('')
          );
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'msg_stub',
            type: 'message',
            role: 'assistant',
            model: 'claude-shared-test',
            content: [{ type: 'text', text: 'shared answer' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 4, output_tokens: 2 },
          })
        );
      });
    });
    await new Promise<void>((resolve) => {
      providerStub.listen(0, '127.0.0.1', resolve);
    });
    const { port } = providerStub.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  const admin = () => {
    return authenticatedTestClient(adminToken);
  };

  const grantee = () => {
    return authenticatedTestClient(granteeKey);
  };

  const createProvider = async (args: {
    name: string;
    baseUrl: string;
    requirePricedModel?: boolean;
  }): Promise<string> => {
    const secret = await admin()
      .post('/api/v1/secrets')
      .send({
        project_id: publisherId,
        name: `${args.name} key`,
        value: 'sk-publisher',
      });
    const provider = await admin()
      .post('/api/v1/ai-providers')
      .send({
        project_id: publisherId,
        name: args.name,
        provider: 'anthropic',
        default_model: 'claude-shared-test',
        secret_id: secret.body.id,
        base_url: args.baseUrl,
        model_aliases: { fast: 'claude-shared-test' },
        ...(args.requirePricedModel ? { require_priced_model: true } : {}),
      });
    expect(provider.status).toBe(201);
    return provider.body.id as string;
  };

  const share = async (
    providerId: string,
    cap?: { calls: number; window: string }
  ): Promise<string> => {
    const created = await admin()
      .post('/api/v1/shares')
      .send({
        project_id: publisherId,
        resource: `srn:${publisherId}:aiProvider:${providerId}`,
        actions: ['ai-providers:UseAiProvider'],
        grantee: granteeId,
        ...(cap ? { cap } : {}),
      });
    expect(created.status).toBe(201);
    const accepted = await grantee().post(
      `/api/v1/shares/${created.body.id}/accept`
    );
    expect(accepted.status).toBe(200);
    return created.body.id as string;
  };

  const pinAgent = (args: { providerId: string; model?: string }) => {
    return grantee()
      .post('/api/v1/agents')
      .send({
        name: `pinned-${Math.random().toString(36).slice(2, 8)}`,
        ai_provider_id: args.providerId,
        model: args.model ?? 'claude-shared-test',
        instructions: 'Answer.',
      });
  };

  const generate = (agentId: string) => {
    return grantee()
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'hello' }] });
  };

  const generateStream = (agentId: string) => {
    return grantee()
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'hello' }], stream: true });
  };

  // A port that was just bound and released refuses connections.
  const closedPortUrl = async (): Promise<string> => {
    const probe = createServer();
    await new Promise<void>((resolve) => {
      probe.listen(0, '127.0.0.1', resolve);
    });
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => {
      probe.close(() => {
        resolve();
      });
    });
    return `http://127.0.0.1:${port}`;
  };

  let baseUrl: string;

  beforeAll(async () => {
    baseUrl = await startProviderStub();

    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'sharedprovideradmin', password: 'supersecret' });
    adminToken = await loginAs('sharedprovideradmin', 'supersecret');

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

    const priced = await admin()
      .put(`/api/v1/projects/${publisherId}/prices`)
      .send({
        prices: ['input_tokens', 'output_tokens'].map((component) => {
          return {
            provider: 'anthropic',
            model: 'claude-shared-test',
            component,
            unit: 'token',
            unit_price: 0.001,
            effective_from: '2026-01-01T00:00:00Z',
          };
        }),
      });
    expect(priced.status).toBe(200);

    sharedProviderId = await createProvider({ name: 'Shared', baseUrl });
    shareId = await share(sharedProviderId);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      providerStub.close(() => {
        resolve();
      });
    });
  });

  describe('GET /api/v1/ai-providers/:ai_provider_id', () => {
    test('the grantee reads the projection only', async () => {
      const response = await grantee().get(
        `/api/v1/ai-providers/${sharedProviderId}`
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        id: sharedProviderId,
        name: 'Shared',
        provider: 'anthropic',
        default_model: 'claude-shared-test',
        model_alias_names: ['fast'],
        model_input_modalities: {},
        model_input_limits: {},
      });
    });

    test('401 without credentials', async () => {
      const response = await testClient.get(
        `/api/v1/ai-providers/${sharedProviderId}`
      );

      expect(response.status).toBe(401);
    });

    test('403 for a grantee credential without ai-providers:GetAiProvider', async () => {
      const policyId = await createProjectPolicy({
        adminToken,
        projectId: granteeId,
        actions: ['agents:*'],
      });
      const narrowKey = (
        await admin()
          .post('/api/v1/api-keys')
          .send({
            name: 'Narrow grantee key',
            project_id: granteeId,
            policy_ids: [policyId],
          })
      ).body.key as string;

      const response = await authenticatedTestClient(narrowKey).get(
        `/api/v1/ai-providers/${sharedProviderId}`
      );

      expect(response.status).toBe(403);
    });
  });

  describe('POST /api/v1/shares', () => {
    test('a provider with no secret and no aliases shares as its projection', async () => {
      const bare = await admin().post('/api/v1/ai-providers').send({
        project_id: publisherId,
        name: 'Bare',
        provider: 'anthropic',
        default_model: 'claude-shared-test',
      });
      expect(bare.status).toBe(201);
      await share(bare.body.id);

      const response = await grantee().get(
        `/api/v1/ai-providers/${bare.body.id}`
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        id: bare.body.id,
        name: 'Bare',
        provider: 'anthropic',
        default_model: 'claude-shared-test',
        model_alias_names: [],
        model_input_modalities: {},
        model_input_limits: {},
      });
    });

    test('a provider that does not exist is AI_PROVIDER_NOT_FOUND', async () => {
      const response = await admin()
        .post('/api/v1/shares')
        .send({
          project_id: publisherId,
          resource: `srn:${publisherId}:aiProvider:aip_missing00000000000`,
          actions: ['ai-providers:UseAiProvider'],
          grantee: granteeId,
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('AI_PROVIDER_NOT_FOUND');
    });
  });

  describe('what the grantee cannot do', () => {
    test.each([
      ['patch', ''],
      ['delete', ''],
      ['get', '/models'],
      ['get', '/prices'],
    ] as const)('%s %s is not found', async (method, suffix) => {
      const response = await grantee()[method](
        `/api/v1/ai-providers/${sharedProviderId}${suffix}`
      );

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });
  });

  describe('POST /api/v1/agents/:agent_id/generate', () => {
    test('an agent pinned to the shared provider generates, metered in the grantee at the publisher price', async () => {
      const agent = await pinAgent({ providerId: sharedProviderId });
      expect(agent.status).toBe(201);

      const response = await generate(agent.body.id);
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('completed');

      const events = await grantee().get('/api/v1/usage/events').query({
        meter_type: 'llm_tokens',
        generation_id: response.body.id,
      });
      expect(events.status).toBe(200);
      expect(events.body.data[0]).toMatchObject({
        project_id: granteeId,
        ai_provider_id: sharedProviderId,
      });
      expect(Number(events.body.data[0].cost_usd)).toBeCloseTo(0.006);
    });

    test('a shared facade serves its forwarded alias on the target in the publisher project', async () => {
      const facade = await admin()
        .post('/api/v1/ai-providers')
        .send({
          project_id: publisherId,
          name: 'Shared facade',
          provider: 'anthropic',
          default_model: 'served',
          model_aliases: {
            served: {
              ai_provider_id: sharedProviderId,
              model: 'claude-shared-test',
            },
          },
          model_aliases_only: true,
        });
      expect(facade.status).toBe(201);
      await share(facade.body.id);
      const agent = await pinAgent({
        providerId: facade.body.id,
        model: 'served',
      });
      expect(agent.status).toBe(201);

      const response = await generate(agent.body.id);
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('completed');

      const events = await grantee().get('/api/v1/usage/events').query({
        meter_type: 'llm_tokens',
        generation_id: response.body.id,
      });
      expect(events.body.data[0]).toMatchObject({
        project_id: granteeId,
        ai_provider_id: facade.body.id,
        model: 'served',
      });
    });

    test('a vendor failure reaches the grantee without the vendor detail', async () => {
      const agent = await pinAgent({ providerId: sharedProviderId });
      const ownAgent = await admin().post('/api/v1/agents').send({
        project_id: publisherId,
        name: 'publisher-pinned',
        ai_provider_id: sharedProviderId,
        model: 'claude-shared-test',
      });
      failing = true;
      try {
        const response = await generate(agent.body.id);
        const own = await admin()
          .post(`/api/v1/agents/${ownAgent.body.id}/generate?wait=true`)
          .send({ messages: [{ role: 'user', content: 'hello' }] });
        const body = JSON.stringify(response.body);

        expect(JSON.stringify(own.body)).toContain(VENDOR_DETAIL);
        expect(own.body.error.code).toBe('AI_PROVIDER_ERROR');
        expect(response.status).toBe(502);
        expect(response.body.error.code).toBe('SHARED_AI_PROVIDER_ERROR');
        expect(response.body.error.hint).not.toBe(own.body.error.hint);
        expect(body).not.toContain(VENDOR_DETAIL);
        expect(body).not.toContain('provider_status_code');
      } finally {
        failing = false;
      }
    });

    test('a vendor failure opening a stream reaches the grantee without the vendor detail', async () => {
      const agent = await pinAgent({ providerId: sharedProviderId });
      failing = true;
      try {
        const response = await generateStream(agent.body.id);

        expect(response.text).not.toContain(VENDOR_DETAIL);
        expect(response.text).toContain('SHARED_AI_PROVIDER_ERROR');
      } finally {
        failing = false;
      }
    });

    test('a streamed vendor error reaches the grantee without the vendor detail', async () => {
      const agent = await pinAgent({ providerId: sharedProviderId });
      streamFailing = true;
      try {
        const response = await generateStream(agent.body.id);

        expect(response.text).not.toContain(VENDOR_DETAIL);
        expect(response.text).toContain('SHARED_AI_PROVIDER_ERROR');
      } finally {
        streamFailing = false;
      }
    });

    test('an unreachable shared provider answers the grantee 502', async () => {
      const unreachableId = await createProvider({
        name: 'Unreachable',
        baseUrl: await closedPortUrl(),
      });
      await share(unreachableId);
      const agent = await pinAgent({ providerId: unreachableId });

      const response = await generate(agent.body.id);

      expect(response.status).toBe(502);
      expect(response.body.error.code).toBe('SHARED_AI_PROVIDER_ERROR');
      expect(JSON.stringify(response.body)).not.toContain('127.0.0.1');
    });

    test('an unpriced model on a provider requiring prices is refused', async () => {
      const strictId = await createProvider({
        name: 'Strict',
        baseUrl,
        requirePricedModel: true,
      });
      await share(strictId);
      const agent = await pinAgent({
        providerId: strictId,
        model: 'claude-unpriced',
      });

      const response = await generate(agent.body.id);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('MODEL_NOT_PRICED');
    });
  });

  describe('share cap', () => {
    test('a generation past the cap is refused before the vendor call', async () => {
      const cappedId = await createProvider({ name: 'Capped', baseUrl });
      await share(cappedId, { calls: 1, window: 'rolling_24h' });
      const agent = await pinAgent({ providerId: cappedId });
      await generate(agent.body.id);

      const refused = await generate(agent.body.id);

      expect(refused.status).toBe(429);
      expect(refused.body.error.code).toBe('SHARE_CAP_EXCEEDED');
    });
  });

  describe('POST /api/v1/model-routes', () => {
    test('a grantee route targets the shared provider', async () => {
      const response = await grantee()
        .post('/api/v1/model-routes')
        .send({
          name: 'shared-route',
          targets: [
            { ai_provider_id: sharedProviderId, model: 'claude-shared-test' },
          ],
        });

      expect(response.status).toBe(201);
    });
  });

  describe('without an accepted share', () => {
    test('a provider that is not shared does not resolve', async () => {
      const unsharedId = await createProvider({ name: 'Unshared', baseUrl });

      const response = await pinAgent({ providerId: unsharedId });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('AI_PROVIDER_NOT_FOUND');
    });

    test('a revoked share no longer resolves', async () => {
      const revokedId = await createProvider({ name: 'Revoked', baseUrl });
      const revokedShare = await share(revokedId);
      await admin().post(`/api/v1/shares/${revokedShare}/revoke`);

      const response = await pinAgent({ providerId: revokedId });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('AI_PROVIDER_NOT_FOUND');
    });
  });

  describe('GET /api/v1/shares/:share_id/references', () => {
    test('lists the grantee agents pinned to the shared provider', async () => {
      const agent = await pinAgent({ providerId: sharedProviderId });

      const response = await grantee().get(
        `/api/v1/shares/${shareId}/references`
      );

      expect(response.status).toBe(200);
      expect(response.body.data).toContainEqual({
        type: 'agent',
        id: agent.body.id,
      });
    });
  });

  describe('DELETE /api/v1/ai-providers/:ai_provider_id', () => {
    test('accepted shares refuse the delete until force, which revokes them', async () => {
      const deletedId = await createProvider({ name: 'Deleted', baseUrl });
      await share(deletedId);

      const refused = await admin().delete(`/api/v1/ai-providers/${deletedId}`);
      const forced = await admin().delete(
        `/api/v1/ai-providers/${deletedId}?force=true`
      );

      expect(refused.status).toBe(409);
      expect(refused.body.error.meta.accepted_share_count).toBe(1);
      expect(forced.status).toBe(204);
    });
  });
});
