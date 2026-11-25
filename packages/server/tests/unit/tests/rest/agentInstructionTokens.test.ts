import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import {
  startStubChatProvider,
  type StubChatProvider,
  stubCompletion,
} from '../../fixtures/stubChatProvider';
import { authenticatedTestClient } from '../../testClient';

/**
 * `{{generation:...}}` tokens in an agent's `instructions`, read where they
 * matter: the system prompt the provider receives, and the clock the
 * generation records.
 */

type ChatMessage = { role?: string; content?: unknown };

const pad = (value: number) => {
  return String(value).padStart(2, '0');
};

/** `instant` as ISO 8601 at a fixed offset, to the second. */
const isoAtOffset = (instant: Date, offsetMinutes: number): string => {
  const local = new Date(instant.getTime() + offsetMinutes * 60_000);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
};

describe('Agent instruction tokens', () => {
  let adminToken: string;
  let projectId: string;
  let aiProviderId: string;
  let stub: StubChatProvider;
  let requests: Array<{ messages?: ChatMessage[] }>;

  beforeAll(async () => {
    requests = [];
    stub = await startStubChatProvider({
      reply: (request) => {
        requests.push(request);
        return stubCompletion({ model: request.model });
      },
    });
    const setup = await setupProjectWithUsers({
      prefix: 'instrtokens',
      policyActions: [],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;
    const provider = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'instr tokens provider',
        provider: 'ollama',
        default_model: 'stub-model',
        base_url: stub.baseUrl,
      });
    expect(provider.status).toBe(201);
    aiProviderId = provider.body.id;
  });

  afterAll(async () => {
    await stub.close();
  });

  const createAgent = (body: Record<string, unknown>) => {
    return authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({ project_id: projectId, ai_provider_id: aiProviderId, ...body });
  };

  const createdAgentId = async (body: Record<string, unknown>) => {
    const res = await createAgent(body);
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  /** Generates once; answers the system prompt sent and the generation. */
  const generate = async (
    agentId: string,
    extra: Record<string, unknown> = {}
  ) => {
    const before = requests.length;
    const res = await authenticatedTestClient(adminToken)
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'hi' }], ...extra });
    expect(res.status).toBe(200);
    const sent = requests[before]?.messages ?? [];
    const generation = await authenticatedTestClient(adminToken).get(
      `/api/v1/generations/${res.body.id}`
    );
    expect(generation.status).toBe(200);
    return {
      system: sent
        .filter((message) => {
          return message.role === 'system';
        })
        .map((message) => {
          return message.content;
        }),
      generation: generation.body as { started_at: string; timezone: string },
    };
  };

  describe('POST /api/v1/agents/:agent_id/generate', () => {
    test('sends the resolved date, in UTC by default, from the recorded start', async () => {
      const agentId = await createdAgentId({
        instructions: 'Be brief. Today is {{generation:now:yyyy-MM-dd}}',
      });

      const { system, generation } = await generate(agentId);

      expect(generation.timezone).toBe('UTC');
      expect(system).toEqual([
        `Be brief. Today is ${generation.started_at.slice(0, 10)}`,
      ]);
    });

    test("renders now and the timezone in the agent's timezone", async () => {
      const agentId = await createdAgentId({
        instructions: '{{generation:now}} | {{generation:timezone}}',
        timezone: 'America/Sao_Paulo',
      });

      const { system, generation } = await generate(agentId);

      expect(generation.timezone).toBe('America/Sao_Paulo');
      expect(system).toEqual([
        `${isoAtOffset(new Date(generation.started_at), -180)} | America/Sao_Paulo`,
      ]);
    });

    test('a timezone on the request overrides the agent for that turn', async () => {
      const agentId = await createdAgentId({
        instructions: '{{generation:now:EEEE HH:mmZ}} {{generation:timezone}}',
        timezone: 'America/Sao_Paulo',
      });

      const { system, generation } = await generate(agentId, {
        timezone: 'Asia/Tokyo',
      });

      const tokyo = isoAtOffset(new Date(generation.started_at), 540);
      const weekday = new Date(
        `${tokyo.slice(0, 10)}T00:00:00Z`
      ).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
      expect(generation.timezone).toBe('Asia/Tokyo');
      expect(system).toEqual([
        `${weekday} ${tokyo.slice(11, 16)}+09:00 Asia/Tokyo`,
      ]);
    });

    test('instructions without a generation token are sent byte-identical', async () => {
      const instructions =
        'Say {{context:tenant}} and {{secret:sec_x}} as written.\n  Keep {braces}.';
      const agentId = await createdAgentId({ instructions });

      const { system } = await generate(agentId);

      expect(system).toEqual([instructions]);
    });

    test('an unknown request timezone is refused before the provider is called', async () => {
      const agentId = await createdAgentId({ instructions: 'x' });
      const before = requests.length;

      const res = await authenticatedTestClient(adminToken)
        .post(`/api/v1/agents/${agentId}/generate?wait=true`)
        .send({
          messages: [{ role: 'user', content: 'hi' }],
          timezone: 'Mars/Olympus',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(requests.length).toBe(before);
    });
  });

  describe('POST /api/v1/conversations/:conversation_id/generate', () => {
    test('sends the resolved instructions once', async () => {
      const agentId = await createdAgentId({
        name: 'Clerk',
        instructions: 'Today is {{generation:now:yyyy-MM-dd}}',
      });
      const conversation = await authenticatedTestClient(adminToken)
        .post('/api/v1/conversations')
        .send({ project_id: projectId });
      expect(conversation.status).toBe(201);
      const message = await authenticatedTestClient(adminToken)
        .post(`/api/v1/conversations/${conversation.body.id}/messages`)
        .send({ message: 'hello', role: 'user' });
      expect(message.status).toBe(201);
      const before = requests.length;

      const res = await authenticatedTestClient(adminToken)
        .post(
          `/api/v1/conversations/${conversation.body.id}/generate?wait=true`
        )
        .send({ agent_id: agentId });

      expect(res.status).toBe(200);
      const system = (requests[before]?.messages ?? [])
        .filter((entry) => {
          return entry.role === 'system';
        })
        .map((entry) => {
          return String(entry.content);
        })
        .join('\n');
      const today = new Date().toISOString().slice(0, 10);
      expect(system.match(/Today is /g)).toHaveLength(1);
      expect(system).toContain(`Today is ${today}`);
      expect(system).not.toContain('{{generation:');
    });
  });

  describe('agent writes', () => {
    test('GET returns the instructions unresolved and the timezone', async () => {
      const instructions = 'Now: {{generation:now:yyyy-MM-dd HH:mm}}';
      const agentId = await createdAgentId({ instructions });

      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/agents/${agentId}`
      );

      expect(res.status).toBe(200);
      expect(res.body.instructions).toBe(instructions);
      expect(res.body.timezone).toBe('UTC');
    });

    test.each([
      [
        'an unknown token',
        'It is {{generation:today}}',
        '{{generation:today}}',
      ],
      [
        'an unknown format field',
        'It is {{generation:now:yyyy-QQ}}',
        '{{generation:now:yyyy-QQ}}',
      ],
      ['an empty format', 'It is {{generation:now:}}', '{{generation:now:}}'],
      [
        'an argument on timezone',
        'Zone {{generation:timezone:short}}',
        '{{generation:timezone:short}}',
      ],
    ])('create refuses %s, naming it', async (_label, instructions, token) => {
      const res = await createAgent({ instructions });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.message).toContain(token);
      expect(res.body.error.message).toContain('{{generation:now}}');
    });

    test('PATCH refuses an unknown token', async () => {
      const agentId = await createdAgentId({ instructions: 'ok' });

      const res = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/agents/${agentId}`)
        .send({ instructions: '{{generation:nowish}}' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('create refuses a timezone that is not an IANA name', async () => {
      const res = await createAgent({ timezone: 'GMT+3 somewhere' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a formation template refuses an unknown token, naming it', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/formations/validate')
        .send({
          template: {
            resources: {
              Clerk: {
                type: 'agent',
                properties: {
                  ai_provider_id: aiProviderId,
                  instructions: 'Today is {{generation:today}}',
                },
              },
            },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(JSON.stringify(res.body.errors)).toContain('{{generation:today}}');
    });

    test('PATCH stores a timezone in its canonical form', async () => {
      const agentId = await createdAgentId({ instructions: 'ok' });

      const res = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/agents/${agentId}`)
        .send({ timezone: 'europe/lisbon' });

      expect(res.status).toBe(200);
      expect(res.body.timezone).toBe('Europe/Lisbon');
    });
  });
});
