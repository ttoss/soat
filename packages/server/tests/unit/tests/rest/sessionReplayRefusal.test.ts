import type { Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

const VENDOR_DETAIL = 'vendor-secret-detail';
const PROMPT_TOO_LONG = `prompt is too long: 1100000 tokens > 1000000 maximum ${VENDOR_DETAIL}`;
const INPUT_TOO_LONG = `Input is too long for requested model. ${VENDOR_DETAIL}`;
const INPUT_TOKENS_EXCEEDED = `Input Tokens Exceeded: Number of input tokens exceeds maximum length. Please update the input to try again. ${VENDOR_DETAIL}`;

/**
 * A session turn the vendor refuses names a cause classified from the vendor's
 * status and body and the positions the turn replayed, never the vendor's text: on the
 * project's own provider, through a forwarded alias and through a share.
 */
describe('Session replay refusal', () => {
  let stub: Server;
  let refuseWith: number | null = null;
  let refusalText = VENDOR_DETAIL;
  let adminToken: string;
  let granteeKey: string;
  const agents: Record<'own' | 'forwarded' | 'shared', string> = {
    own: '',
    forwarded: '',
    shared: '',
  };

  const startStub = async (): Promise<string> => {
    stub = createServer((req, res: ServerResponse) => {
      req.resume();
      req.on('end', () => {
        if (refuseWith !== null) {
          res.writeHead(refuseWith, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              type: 'error',
              error: { type: 'invalid_request_error', message: refusalText },
            })
          );
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'msg_stub',
            type: 'message',
            role: 'assistant',
            model: 'claude-replay-test',
            content: [{ type: 'text', text: 'answer' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 4, output_tokens: 2 },
          })
        );
      });
    });
    await new Promise<void>((resolve) => {
      stub.listen(0, '127.0.0.1', resolve);
    });
    const { port } = stub.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  const tokenFor = (via: keyof typeof agents) => {
    return via === 'shared' ? granteeKey : adminToken;
  };

  /** A session whose second turn the vendor answers with `status`. */
  const refusedTurn = async (args: {
    via: keyof typeof agents;
    status: number;
    text?: string;
  }) => {
    const client = authenticatedTestClient(tokenFor(args.via));
    const session = await client
      .post('/api/v1/sessions')
      .send({ agent_id: agents[args.via] });
    expect(session.status).toBe(201);
    const say = async () => {
      const sent = await client
        .post(`/api/v1/sessions/${session.body.id}/messages`)
        .send({ message: 'go' });
      expect(sent.status).toBeLessThan(300);
    };
    const generate = () => {
      return client.post(
        `/api/v1/sessions/${session.body.id}/generate?wait=true`
      );
    };
    await say();
    expect((await generate()).status).toBe(200);
    await say();
    refuseWith = args.status;
    refusalText = args.text ?? VENDOR_DETAIL;
    try {
      return await generate();
    } finally {
      refuseWith = null;
      refusalText = VENDOR_DETAIL;
    }
  };

  beforeAll(async () => {
    const baseUrl = await startStub();
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'replayrefusaladmin', password: 'supersecret' });
    adminToken = await loginAs('replayrefusaladmin', 'supersecret');
    const admin = authenticatedTestClient(adminToken);

    const publisherId = (
      await admin.post('/api/v1/projects').send({ name: 'Replay publisher' })
    ).body.id;
    const granteeId = (
      await admin.post('/api/v1/projects').send({ name: 'Replay grantee' })
    ).body.id;
    granteeKey = (
      await admin
        .post('/api/v1/api-keys')
        .send({ name: 'Replay grantee key', project_id: granteeId })
    ).body.key;

    const secret = await admin
      .post('/api/v1/secrets')
      .send({ project_id: publisherId, name: 'Replay key', value: 'sk' });
    const provider = await admin.post('/api/v1/ai-providers').send({
      project_id: publisherId,
      name: 'Replay vendor',
      provider: 'anthropic',
      default_model: 'claude-replay-test',
      secret_id: secret.body.id,
      base_url: baseUrl,
    });
    expect(provider.status).toBe(201);
    const facade = await admin.post('/api/v1/ai-providers').send({
      project_id: publisherId,
      name: 'Replay facade',
      provider: 'anthropic',
      default_model: 'served',
      model_aliases: {
        served: {
          ai_provider_id: provider.body.id,
          model: 'claude-replay-test',
        },
      },
      model_aliases_only: true,
    });
    expect(facade.status).toBe(201);

    const shared = await admin.post('/api/v1/shares').send({
      project_id: publisherId,
      resource: `srn:${publisherId}:aiProvider:${provider.body.id}`,
      actions: ['ai-providers:UseAiProvider'],
      grantee: granteeId,
    });
    expect(shared.status).toBe(201);
    const accepted = await authenticatedTestClient(granteeKey).post(
      `/api/v1/shares/${shared.body.id}/accept`
    );
    expect(accepted.status).toBe(200);

    const createAgent = async (args: {
      token: string;
      body: Record<string, unknown>;
    }) => {
      const agent = await authenticatedTestClient(args.token)
        .post('/api/v1/agents')
        .send({ name: `replay-${Math.random()}`, ...args.body });
      expect(agent.status).toBe(201);
      return agent.body.id as string;
    };
    agents.own = await createAgent({
      token: adminToken,
      body: {
        project_id: publisherId,
        ai_provider_id: provider.body.id,
        model: 'claude-replay-test',
      },
    });
    agents.forwarded = await createAgent({
      token: adminToken,
      body: {
        project_id: publisherId,
        ai_provider_id: facade.body.id,
        model: 'served',
      },
    });
    agents.shared = await createAgent({
      token: granteeKey,
      body: { ai_provider_id: provider.body.id, model: 'claude-replay-test' },
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      stub.close(() => {
        resolve();
      });
    });
  });

  describe('POST /api/v1/sessions/{session_id}/generate', () => {
    test.each([
      ['own', 400, VENDOR_DETAIL, 'history_refused'],
      ['own', 413, VENDOR_DETAIL, 'context_too_long'],
      ['own', 422, VENDOR_DETAIL, 'request_refused'],
      ['own', 400, PROMPT_TOO_LONG, 'context_too_long'],
      ['own', 400, INPUT_TOKENS_EXCEEDED, 'context_too_long'],
      ['own', 400, INPUT_TOO_LONG, 'context_too_long'],
      ['forwarded', 400, VENDOR_DETAIL, 'history_refused'],
      ['forwarded', 413, VENDOR_DETAIL, 'context_too_long'],
      ['forwarded', 400, PROMPT_TOO_LONG, 'context_too_long'],
      ['shared', 400, VENDOR_DETAIL, 'history_refused'],
      ['shared', 413, VENDOR_DETAIL, 'context_too_long'],
      ['shared', 400, PROMPT_TOO_LONG, 'context_too_long'],
      ['shared', 400, INPUT_TOKENS_EXCEEDED, 'context_too_long'],
    ] as const)(
      'a %s provider refusing with %i "%s" is REPLAY_REFUSED for %s',
      async (via, status, text, cause) => {
        const response = await refusedTurn({ via, status, text });

        expect(response.status).toBe(502);
        expect(response.body.error).toMatchObject({
          code: 'REPLAY_REFUSED',
          meta: {
            cause,
            replayed_window: { first_position: 0, last_position: 2 },
          },
        });
        expect(response.body.error.hint).toContain('fork');
        expect(JSON.stringify(response.body)).not.toContain(VENDOR_DETAIL);
        expect(response.body.error.meta).not.toHaveProperty(
          'provider_status_code'
        );

        const generation = await authenticatedTestClient(tokenFor(via)).get(
          `/api/v1/generations/${response.body.error.meta.generation_id}`
        );
        expect(generation.body.error).toMatchObject({
          code: 'REPLAY_REFUSED',
        });
      }
    );

    test('a retryable vendor fault is not a refusal of the replay', async () => {
      const response = await refusedTurn({ via: 'own', status: 429 });

      expect(response.status).toBe(502);
      expect(response.body.error.code).toBe('AI_PROVIDER_ERROR');
    });

    test('401 without credentials', async () => {
      const response = await testClient.post(
        '/api/v1/sessions/sess_missing/generate?wait=true'
      );

      expect(response.status).toBe(401);
    });
  });
});
