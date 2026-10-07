import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { db } from 'src/db';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

const ACTIONS = [
  'deciders:CreateInlineDecision',
  'deciders:GetDecision',
  'deciders:ListDecisions',
];

const QUESTIONS = [
  {
    type: 'choice',
    name: 'route',
    instructions: 'Which team should own this ticket?',
    choices: [
      { value: 'billing', description: 'Charges, refunds, invoices' },
      { value: 'technical', description: 'Errors, outages, integrations' },
    ],
  },
  {
    type: 'score',
    name: 'severity',
    instructions: 'How urgent is this ticket?',
    levels: [
      { label: 'Cosmetic', description: 'Appearance only.' },
      { label: 'Blocking', description: 'No workaround.' },
    ],
  },
  {
    type: 'predicate',
    name: 'needs_human',
    instructions: 'Must a person read this before any automated reply?',
  },
];

const MODEL_ANSWER = { route: 'technical', severity: 1, needs_human: true };

const TOOL_ANSWER = {
  answers: [
    { name: 'route', choice: 'billing' },
    { name: 'severity', score: 0 },
    { name: 'needs_human', probability: 0.2 },
  ],
};

const CHAT_PATH = '/v1/chat/completions';

type Received = Record<string, Array<Record<string, unknown>>>;

describe('Decisions — inline questions', () => {
  let stubServer: Server;
  let stubBaseUrl: string;
  const received: Received = {};

  let adminToken: string;
  let userToken: string;
  let noPermToken: string;
  let projectId: string;
  let agentId: string;
  let toolId: string;
  let otherProjectAgentId: string;
  let seq = 0;

  const unique = (base: string): string => {
    seq += 1;
    return `${base}-${seq}`;
  };

  /** Answers the agent's chat completion and the tool's HTTP call alike. */
  const startStubServer = async (): Promise<string> => {
    stubServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on('end', () => {
        const path = req.url ?? '/';
        (received[path] ??= []).push(
          JSON.parse(Buffer.concat(chunks).toString('utf-8'))
        );
        const body =
          path === CHAT_PATH
            ? {
                id: 'chatcmpl-stub',
                object: 'chat.completion',
                created: 0,
                model: 'stub-model',
                choices: [
                  {
                    index: 0,
                    message: {
                      role: 'assistant',
                      content: JSON.stringify(MODEL_ANSWER),
                    },
                    finish_reason: 'stop',
                  },
                ],
                usage: {
                  prompt_tokens: 1,
                  completion_tokens: 1,
                  total_tokens: 2,
                },
              }
            : TOOL_ANSWER;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => {
      stubServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = stubServer.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  const createAgentIn = async (args: {
    project: string;
    name: string;
  }): Promise<string> => {
    const providerRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: args.project,
        name: unique('inline-provider'),
        provider: 'ollama',
        default_model: 'stub-model',
        base_url: stubBaseUrl,
      });
    expect(providerRes.status).toBe(201);
    const agentRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: args.project,
        ai_provider_id: providerRes.body.id,
        name: args.name,
        instructions: 'You triage support tickets.',
      });
    expect(agentRes.status).toBe(201);
    return agentRes.body.id as string;
  };

  const createTool = async (body: Record<string, unknown>) => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({ project_id: projectId, name: unique('tool'), ...body });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const decideInline = (args: {
    token?: string;
    body?: Record<string, unknown>;
  }) => {
    return authenticatedTestClient(args.token ?? userToken)
      .post('/api/v1/decisions')
      .send({
        project_id: projectId,
        agent_id: agentId,
        questions: QUESTIONS,
        input: 'I was charged twice.',
        wait: true,
        ...args.body,
      });
  };

  const countDecisions = async (): Promise<number> => {
    return db.Decision.count();
  };

  beforeAll(async () => {
    stubBaseUrl = await startStubServer();

    const setup = await setupProjectWithUsers({
      prefix: 'decisions-inline',
      policyActions: ACTIONS,
      createOtherProject: true,
      createNoPermUser: true,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    noPermToken = setup.noPermToken!;
    projectId = setup.projectId;

    agentId = await createAgentIn({ project: projectId, name: 'inline-judge' });
    otherProjectAgentId = await createAgentIn({
      project: setup.otherProjectId!,
      name: 'other-judge',
    });
    toolId = await createTool({
      type: 'http',
      description: 'Answers a question set',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: true,
      },
      execute: { url: `${stubBaseUrl}/engine`, method: 'POST' },
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      stubServer.close(() => {
        resolve();
      });
    });
  });

  describe('POST /api/v1/decisions', () => {
    test('wait: true with an agent answers the settled decision, carrying its questions', async () => {
      const res = await decideInline({
        body: { metadata: { ticket_id: 'ZD-48213' } },
      });

      const answers = [
        { type: 'choice', name: 'route', choice: 'technical' },
        { type: 'score', name: 'severity', score: 1 },
        { type: 'predicate', name: 'needs_human', probability: 1 },
      ];
      expect(res.status).toBe(201);
      expect(res.body.id).toMatch(/^dec_/);
      expect(res.body.project_id).toBe(projectId);
      expect(res.body.decider_id).toBeNull();
      expect(res.body.decider_version).toBeNull();
      expect(res.body.questions).toEqual(QUESTIONS);
      expect(res.body.status).toBe('completed');
      expect(res.body.answers).toEqual(answers);
      expect(res.body.answers_by_name).toEqual({
        route: answers[0],
        severity: answers[1],
        needs_human: answers[2],
      });
      expect(res.body.error).toBeNull();
      expect(res.body.generation_id).toMatch(/^gen_/);
      expect(res.body.metadata).toEqual({ ticket_id: 'ZD-48213' });
      expect(res.body.input).toBeUndefined();
    });

    test('the agent is shown the inline questions and the input', async () => {
      const before = received[CHAT_PATH]?.length ?? 0;

      await decideInline({ body: { input: 'The dashboard throws a 500.' } });

      const request = received[CHAT_PATH][before] as {
        messages: Array<{ role: string; content: string }>;
      };
      const user = request.messages.find((message) => {
        return message.role === 'user';
      });
      expect(user?.content).toContain(
        '### route (choice)\nWhich team should own this ticket?'
      );
      expect(user?.content).toContain('- 1: Blocking. No workaround.');
      expect(user?.content).toContain(
        '<input>\n\nThe dashboard throws a 500.\n\n</input>'
      );
    });

    test('wait: true with a tool answers from the tool, which receives the input and the questions', async () => {
      const before = received['/engine']?.length ?? 0;

      const res = await decideInline({
        body: {
          agent_id: undefined,
          tool_id: toolId,
          input: { ticket: 'ZD-1' },
        },
      });

      expect(res.status).toBe(201);
      expect(res.body.decider_id).toBeNull();
      expect(res.body.questions).toEqual(QUESTIONS);
      expect(res.body.status).toBe('completed');
      expect(res.body.generation_id).toBeNull();
      expect(res.body.answers).toEqual([
        { type: 'choice', name: 'route', choice: 'billing' },
        { type: 'score', name: 'severity', score: 0 },
        { type: 'predicate', name: 'needs_human', probability: 0.2 },
      ]);
      expect(received['/engine'][before]).toEqual({
        input: { ticket: 'ZD-1' },
        questions: QUESTIONS,
      });
    });

    test('wait: false answers queued, and the decision settles', async () => {
      const res = await decideInline({ body: { wait: false } });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('queued');
      expect(res.body.answers).toBeNull();
      expect(res.body.questions).toEqual(QUESTIONS);
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const read = await authenticatedTestClient(userToken).get(
          `/api/v1/decisions/${res.body.id}`
        );
        if (read.body.status === 'completed') {
          expect(read.body.answers_by_name.route.choice).toBe('technical');
          return;
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 25);
        });
      }
      throw new Error('The decision never settled.');
    });

    test('naming both an agent and a tool is refused with 400', async () => {
      const res = await decideInline({ body: { tool_id: toolId } });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('naming neither an agent nor a tool is refused with 400', async () => {
      const res = await decideInline({ body: { agent_id: undefined } });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a tool-bearing agent is refused before any decision is written', async () => {
      const armed = await createAgentIn({
        project: projectId,
        name: unique('armed-judge'),
      });
      const clientToolId = await createTool({
        type: 'client',
        parameters: { type: 'object', properties: {} },
      });
      const put = await authenticatedTestClient(adminToken)
        .put(`/api/v1/agents/${armed}`)
        .send({ tool_bindings: [{ tool_id: clientToolId }] });
      expect(put.status).toBe(200);
      const before = await countDecisions();

      const res = await decideInline({ body: { agent_id: armed } });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('DECIDER_AGENT_NOT_TOOL_LESS');
      expect(await countDecisions()).toBe(before);
    });

    test('a client tool is refused with 400', async () => {
      const clientToolId = await createTool({
        type: 'client',
        description: 'Runs in the caller',
        parameters: { type: 'object', properties: {} },
      });

      const res = await decideInline({
        body: { agent_id: undefined, tool_id: clientToolId },
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('DECIDER_TOOL_NOT_CALLABLE');
    });

    test('an agent from another project is refused with 400', async () => {
      const res = await decideInline({
        body: { agent_id: otherProjectAgentId },
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('AGENT_NOT_FOUND');
    });

    test('an unknown tool is refused with 400', async () => {
      const res = await decideInline({
        body: { agent_id: undefined, tool_id: 'tool_doesnotexist' },
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TOOL_NOT_FOUND');
    });

    test.each([
      ['no questions', []],
      ['questions keyed by name', { route: QUESTIONS[0] }],
      [
        'a question of a type that does not exist',
        [{ type: 'boolean', name: 'escalate', instructions: 'Escalate it?' }],
      ],
      [
        'a question with a field outside its type',
        [
          {
            type: 'predicate',
            name: 'escalate',
            instructions: 'Escalate it?',
            criteria: { true: 'Legal threat' },
          },
        ],
      ],
      [
        'a choice with a single value',
        [
          {
            type: 'choice',
            name: 'route',
            instructions: 'Which team?',
            choices: [{ value: 'billing', description: 'Charges' }],
          },
        ],
      ],
      [
        'a choice value given twice',
        [
          {
            type: 'choice',
            name: 'route',
            instructions: 'Which team?',
            choices: [
              { value: 'billing', description: 'Charges' },
              { value: 'billing', description: 'Refunds' },
            ],
          },
        ],
      ],
      [
        'a level without a description',
        [
          {
            type: 'score',
            name: 'severity',
            instructions: 'How urgent?',
            levels: [{ label: 'Low' }, { label: 'High' }],
          },
        ],
      ],
      ['a name given twice', [QUESTIONS[2], QUESTIONS[2]]],
      [
        'a name holding a dot',
        [{ type: 'predicate', name: 'needs.human', instructions: 'Escalate?' }],
      ],
    ])('%s is refused with 400', async (_label, questions) => {
      const res = await decideInline({ body: { questions } });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a missing question set is refused with 400', async () => {
      const res = await decideInline({ body: { questions: undefined } });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a missing input is refused with 400', async () => {
      const res = await decideInline({ body: { input: undefined } });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a malformed messages input is refused before any decision is written', async () => {
      const before = await countDecisions();

      const res = await decideInline({
        body: {
          input: [
            {
              role: 'user',
              content: [{ type: 'input_image', image_url: 'not-a-data-url' }],
            },
          ],
        },
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(await countDecisions()).toBe(before);
    });

    test('user without the permission returns 403', async () => {
      const res = await decideInline({ token: noPermToken });

      expect(res.status).toBe(403);
    });

    test('a project key allowed only deciders:CreateDecision returns 403', async () => {
      const policyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [
              { effect: 'Allow', action: ['deciders:CreateDecision'] },
            ],
          },
        });
      const keyRes = await authenticatedTestClient(userToken)
        .post('/api/v1/api-keys')
        .send({
          name: unique('decider-only'),
          project_id: projectId,
          policy_ids: [policyRes.body.id],
        });
      expect(keyRes.status).toBe(201);

      const res = await decideInline({ token: keyRes.body.key });

      expect(res.status).toBe(403);
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.post('/api/v1/decisions').send({
        project_id: projectId,
        agent_id: agentId,
        questions: QUESTIONS,
        input: 'x',
      });

      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v1/decisions/{decision_id}', () => {
    test('returns an inline decision with its questions', async () => {
      const made = await decideInline({});

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/decisions/${made.body.id}`
      );

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(made.body.id);
      expect(res.body.decider_id).toBeNull();
      expect(res.body.questions).toEqual(QUESTIONS);
      expect(res.body.answers).toEqual(made.body.answers);
    });
  });

  describe('GET /api/v1/decisions', () => {
    test('lists inline decisions beside the project’s others', async () => {
      const made = await decideInline({});

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/decisions?project_id=${projectId}&limit=100`
      );

      expect(res.status).toBe(200);
      const listed = (res.body.data as Array<{ id: string }>).find(
        (decision) => {
          return decision.id === made.body.id;
        }
      );
      expect(listed).toMatchObject({
        decider_id: null,
        questions: QUESTIONS,
      });
    });
  });
});
