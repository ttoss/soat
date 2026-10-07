import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { db } from 'src/db';

import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import {
  createQuotaRow,
  freshProjectAndAgent,
  seedUsageEvent,
} from '../../fixtures/quotaSeed';
import { authenticatedTestClient } from '../../testClient';

const ACTIONS = [
  'deciders:CreateDecider',
  'deciders:UpdateDecider',
  'deciders:GetDecider',
  'deciders:CreateDecision',
  'deciders:GetDecision',
  'tools:CreateTool',
  'tools:UpdateTool',
  'tools:DeleteTool',
  'usage:ListEvents',
];

const QUESTIONS = [
  {
    type: 'choice',
    name: 'route',
    instructions: 'Which team should own this ticket?',
    choices: [
      {
        value: 'billing',
        description: 'Charges, refunds, invoices, plan changes',
      },
      {
        value: 'technical',
        description: 'Errors, outages, integration failures',
      },
    ],
  },
  {
    type: 'score',
    name: 'severity',
    instructions: 'How urgent is this ticket?',
    levels: [
      { label: 'Cosmetic', description: 'Cosmetic or informational' },
      { label: 'Workaround', description: 'A workaround exists' },
      {
        label: 'Blocking',
        description: 'Blocks one workflow for one customer',
      },
    ],
  },
  {
    type: 'predicate',
    name: 'needs_human',
    instructions: 'Must a person read this before any automated reply?',
  },
];

type ToolAnswer = { name: string } & Record<string, unknown>;

const TOOL_ANSWERS: ToolAnswer[] = [
  {
    type: 'choice',
    name: 'route',
    choice: 'billing',
    probabilities: [
      { value: 'billing', probability: 0.8 },
      { value: 'technical', probability: 0.2 },
    ],
  },
  { name: 'severity', score: 1 },
  { type: 'predicate', name: 'needs_human', probability: 0.1 },
];

const TOOL_ANSWER = { answers: TOOL_ANSWERS };

/** The tool's answers with the one named `answer.name` replaced. */
const replacing = (answer: ToolAnswer) => {
  return {
    answers: TOOL_ANSWERS.map((each) => {
      return each.name === answer.name ? answer : each;
    }),
  };
};

/**
 * What OpenAI's Decisions API answers: keys beside `answers`, answers out of
 * question order, a fractional score, level labels of its own, confidences.
 */
const OPENAI_ANSWER = {
  id: 'decision_abc123',
  object: 'decision',
  model: 'gpt-5-decisions',
  answers: [
    { type: 'predicate', name: 'needs_human', probability: 0.75 },
    {
      type: 'score',
      name: 'severity',
      score: 1.6,
      probabilities: [
        { value: 0, label: 'low', probability: 0.1 },
        { value: 1, label: 'mid', probability: 0.2 },
        { value: 2, label: 'high', probability: 0.7 },
      ],
      confidence: 0.7,
    },
    {
      type: 'choice',
      name: 'route',
      choice: 'technical',
      probabilities: [
        { value: 'billing', probability: 0.1 },
        { value: 'technical', probability: 0.9 },
      ],
      confidence: 0.9,
    },
  ],
  usage: { input_tokens: 10 },
};

/** {@link OPENAI_ANSWER} as the decision stores it. */
const OPENAI_ANSWERS_STORED = [
  {
    type: 'choice',
    name: 'route',
    choice: 'technical',
    probabilities: [
      { value: 'billing', probability: 0.1 },
      { value: 'technical', probability: 0.9 },
    ],
    confidence: 0.9,
  },
  {
    type: 'score',
    name: 'severity',
    score: 1.6,
    probabilities: [
      { value: 0, label: 'Cosmetic', probability: 0.1 },
      { value: 1, label: 'Workaround', probability: 0.2 },
      { value: 2, label: 'Blocking', probability: 0.7 },
    ],
    confidence: 0.7,
  },
  { type: 'predicate', name: 'needs_human', probability: 0.75 },
];

type StubReply = { status?: number; body: unknown };

describe('Decisions — tool backend', () => {
  let stubServer: Server;
  let stubBaseUrl: string;
  const received: Record<string, Array<Record<string, unknown>>> = {};
  const replies: Record<string, StubReply[]> = {};

  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let agentId: string;
  let httpToolId: string;
  let openaiToolId: string;
  let forwardToolId: string;
  let deciderId: string;
  let seq = 0;

  const unique = (base: string): string => {
    seq += 1;
    return `${base}-${seq}`;
  };

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
        const reply = replies[path]?.shift() ?? {
          body: path === '/openai' ? OPENAI_ANSWER : TOOL_ANSWER,
        };
        const text =
          typeof reply.body === 'string'
            ? reply.body
            : JSON.stringify(reply.body);
        res.writeHead(reply.status ?? 200, {
          'Content-Type':
            typeof reply.body === 'string' ? 'text/plain' : 'application/json',
        });
        res.end(text);
      });
    });
    await new Promise<void>((resolve) => {
      stubServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = stubServer.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  const createTool = async (body: Record<string, unknown>) => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/tools')
      .send({ project_id: projectId, name: unique('tool'), ...body });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const createHttpTool = (
    path: string,
    extra: Record<string, unknown> = {}
  ) => {
    return createTool({
      type: 'http',
      description: 'Answers a question set',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: true,
      },
      execute: { url: `${stubBaseUrl}${path}`, method: 'POST' },
      ...extra,
    });
  };

  const postDecider = (body: Record<string, unknown>) => {
    return authenticatedTestClient(userToken)
      .post('/api/v1/deciders')
      .send({
        project_id: projectId,
        name: unique('triage'),
        questions: QUESTIONS,
        ...body,
      });
  };

  const createDecider = async (body: Record<string, unknown>) => {
    const res = await postDecider(body);
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const decide = (args: {
    decider?: string;
    token?: string;
    body?: Record<string, unknown>;
  }) => {
    return authenticatedTestClient(args.token ?? userToken)
      .post(`/api/v1/deciders/${args.decider ?? deciderId}/decisions`)
      .send({ input: 'I was charged twice.', wait: true, ...args.body });
  };

  /** Queues the stub's next answer on `path`, for a decider over its own tool. */
  const deciderAnswering = async (path: string, reply: StubReply) => {
    (replies[path] ??= []).push(reply);
    return createDecider({ tool_id: await createHttpTool(path) });
  };

  beforeAll(async () => {
    stubBaseUrl = await startStubServer();

    const setup = await setupProjectWithUsers({
      prefix: 'decisions-tool',
      policyActions: ACTIONS,
      createOtherProject: false,
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;

    const providerRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'decisions-tool-provider',
        provider: 'ollama',
        default_model: 'stub-model',
        base_url: stubBaseUrl,
      });
    expect(providerRes.status).toBe(201);
    const agentRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: providerRes.body.id,
        name: 'decisions-tool-judge',
      });
    expect(agentRes.status).toBe(201);
    agentId = agentRes.body.id;

    httpToolId = await createHttpTool('/engine');
    openaiToolId = await createHttpTool('/openai', {
      preset_parameters: { model: 'gpt-5-decisions' },
    });
    forwardToolId = await createTool({
      type: 'pipeline',
      description: 'Forwards the question set to an engine',
      pipeline: {
        steps: [
          {
            id: 'call',
            tool_id: openaiToolId,
            input: {
              input: { var: 'input.input' },
              questions: { var: 'input.questions' },
            },
          },
        ],
        output: { answers: { var: 'steps.call.answers' } },
      },
    });

    deciderId = await createDecider({ tool_id: httpToolId });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      stubServer.close(() => {
        resolve();
      });
    });
  });

  describe('POST /api/v1/deciders', () => {
    test('a tool-backed decider names its tool and no agent', async () => {
      const res = await postDecider({ tool_id: httpToolId });

      expect(res.status).toBe(201);
      expect(res.body.tool_id).toBe(httpToolId);
      expect(res.body.agent_id).toBeNull();
    });

    test('naming both an agent and a tool is refused with 400', async () => {
      const res = await postDecider({ agent_id: agentId, tool_id: httpToolId });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('naming neither an agent nor a tool is refused with 400', async () => {
      const res = await postDecider({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a tool outside the project is refused with 400', async () => {
      const res = await postDecider({ tool_id: 'tool_doesnotexist' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TOOL_NOT_FOUND');
    });

    test.each([
      [
        'client',
        {
          type: 'client',
          description: 'Runs in the caller',
          parameters: { type: 'object', properties: {} },
        },
      ],
      [
        'builtin',
        {
          type: 'builtin',
          description: 'Lists tools',
          actions: ['list-tools'],
        },
      ],
    ])('a %s tool is refused with 400', async (_type, toolBody) => {
      const res = await postDecider({ tool_id: await createTool(toolBody) });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('DECIDER_TOOL_NOT_CALLABLE');
    });

    test('a tool whose presets pin the input is refused with 400', async () => {
      const toolId = await createHttpTool('/engine', {
        preset_parameters: { input: 'always this' },
      });

      const res = await postDecider({ tool_id: toolId });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('DECIDER_TOOL_NOT_CALLABLE');
      expect(res.body.error.meta.pinned).toEqual(['input']);
    });
  });

  describe('PATCH /api/v1/deciders/{decider_id}', () => {
    test('naming a tool replaces the agent and leaves the version', async () => {
      const decider = await createDecider({ agent_id: agentId });

      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/deciders/${decider}`)
        .send({ tool_id: httpToolId });

      expect(res.status).toBe(200);
      expect(res.body.tool_id).toBe(httpToolId);
      expect(res.body.agent_id).toBeNull();
      expect(res.body.version).toBe(1);
    });

    test('naming an agent replaces the tool', async () => {
      const decider = await createDecider({ tool_id: httpToolId });

      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/deciders/${decider}`)
        .send({ agent_id: agentId });

      expect(res.status).toBe(200);
      expect(res.body.agent_id).toBe(agentId);
      expect(res.body.tool_id).toBeNull();
    });

    test('naming both is refused with 400', async () => {
      const decider = await createDecider({ tool_id: httpToolId });

      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/deciders/${decider}`)
        .send({ agent_id: agentId, tool_id: httpToolId });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a client tool is refused with 400', async () => {
      const decider = await createDecider({ agent_id: agentId });
      const clientToolId = await createTool({
        type: 'client',
        description: 'Runs in the caller',
        parameters: { type: 'object', properties: {} },
      });

      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/deciders/${decider}`)
        .send({ tool_id: clientToolId });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('DECIDER_TOOL_NOT_CALLABLE');
    });
  });

  describe('DELETE /api/v1/tools/{tool_id}', () => {
    test('a tool a decider names cannot be deleted', async () => {
      const toolId = await createHttpTool('/engine');
      await createDecider({ tool_id: toolId });

      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/tools/${toolId}`
      );

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('TOOL_HAS_DEPENDENTS');
      expect(res.body.error.meta.decider_count).toBe(1);
    });
  });

  describe('POST /api/v1/deciders/{decider_id}/decisions', () => {
    test('wait: true answers with the tool’s answers, in question order', async () => {
      const res = await decide({});

      const answers = [
        {
          type: 'choice',
          name: 'route',
          choice: 'billing',
          probabilities: [
            { value: 'billing', probability: 0.8 },
            { value: 'technical', probability: 0.2 },
          ],
        },
        { type: 'score', name: 'severity', score: 1 },
        { type: 'predicate', name: 'needs_human', probability: 0.1 },
      ];
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('completed');
      expect(res.body.generation_id).toBeNull();
      expect(res.body.answers).toEqual(answers);
      expect(res.body.answers_by_name).toEqual({
        route: answers[0],
        severity: answers[1],
        needs_human: answers[2],
      });
    });

    test('the tool receives the input and the stored question set', async () => {
      const decider = await createDecider({
        tool_id: await createHttpTool('/request-shape'),
      });

      await decide({ decider, body: { input: { ticket: 'ZD-1' } } });

      expect(received['/request-shape']).toEqual([
        { input: { ticket: 'ZD-1' }, questions: QUESTIONS },
      ]);
    });

    test('a tool forwarding to OpenAI’s Decisions API answers unchanged, with the decider’s labels', async () => {
      const decider = await createDecider({ tool_id: openaiToolId });
      const before = received['/openai']?.length ?? 0;

      const res = await decide({ decider });

      expect(res.body.status).toBe('completed');
      expect(res.body.answers).toEqual(OPENAI_ANSWERS_STORED);
      expect(received['/openai']?.[before]).toEqual({
        model: 'gpt-5-decisions',
        input: 'I was charged twice.',
        questions: QUESTIONS,
      });
    });

    test('a pipeline forwards to an engine and passes its answers through', async () => {
      const decider = await createDecider({ tool_id: forwardToolId });
      const before = received['/openai']?.length ?? 0;

      const res = await decide({ decider });

      expect(res.body.status).toBe('completed');
      expect(res.body.answers).toEqual(OPENAI_ANSWERS_STORED);
      expect(received['/openai']?.[before]).toEqual({
        model: 'gpt-5-decisions',
        input: 'I was charged twice.',
        questions: QUESTIONS,
      });
    });

    test('the call is metered as a tool execution with source decider', async () => {
      const toolId = await createHttpTool('/engine');
      const decider = await createDecider({ tool_id: toolId });

      await decide({ decider });

      const events = await authenticatedTestClient(userToken).get(
        `/api/v1/usage/events?tool_id=${toolId}`
      );
      expect(events.status).toBe(200);
      expect(events.body.data).toHaveLength(1);
      expect(events.body.data[0]).toMatchObject({
        meter_type: 'tool_execution',
        source: 'decider',
      });
    });

    test('an answer sent as JSON text is read', async () => {
      const decider = await deciderAnswering('/text', {
        body: JSON.stringify(TOOL_ANSWER),
      });

      const res = await decide({ decider });

      expect(res.body.status).toBe('completed');
      expect(res.body.answers_by_name.route.choice).toBe('billing');
    });

    test('keys beside answers are ignored', async () => {
      const decider = await deciderAnswering('/extra-keys', {
        body: { ...TOOL_ANSWER, model: 'engine-1', usage: { tokens: 3 } },
      });

      const res = await decide({ decider });

      expect(res.body.status).toBe('completed');
    });

    test('a confidence on a choice and on a score is kept', async () => {
      const decider = await deciderAnswering('/confidence', {
        body: {
          answers: [
            { name: 'route', choice: 'technical', confidence: 0.6 },
            { name: 'severity', score: 0, confidence: 0.4 },
            { name: 'needs_human', probability: 1 },
          ],
        },
      });

      const res = await decide({ decider });

      expect(res.body.status).toBe('completed');
      expect(res.body.answers).toEqual([
        { type: 'choice', name: 'route', choice: 'technical', confidence: 0.6 },
        { type: 'score', name: 'severity', score: 0, confidence: 0.4 },
        { type: 'predicate', name: 'needs_human', probability: 1 },
      ]);
    });

    test('wait: false answers queued, and the decision settles', async () => {
      const res = await decide({ body: { wait: false } });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('queued');
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const row = await db.Decision.findOne({
          where: { publicId: res.body.id },
        });
        if (row?.status === 'completed') return;
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 25);
        });
      }
      throw new Error('The decision never settled.');
    });

    test.each([
      ['a non-object answer', ['billing']],
      ['text that is not JSON', 'billing, probably'],
      ['no answers', { model: 'engine-1' }],
      [
        'answers that are not an array',
        { answers: { route: { choice: 'billing' } } },
      ],
      ['an answer that is not an object', { answers: ['billing'] }],
      ['a missing answer', { answers: TOOL_ANSWERS.slice(0, 2) }],
      [
        'a question answered twice',
        { answers: [...TOOL_ANSWERS, { name: 'route', choice: 'technical' }] },
      ],
      [
        'an answer to no question',
        { answers: [...TOOL_ANSWERS, { name: 'tone', choice: 'calm' }] },
      ],
      [
        'an answer without a name',
        { answers: [...TOOL_ANSWERS, { choice: 'calm' }] },
      ],
      [
        'a type that is not the question’s',
        replacing({ type: 'choice', name: 'needs_human', probability: 0.5 }),
      ],
      [
        'a field outside the contract',
        replacing({ name: 'needs_human', probability: 0.5, confidence: 0.5 }),
      ],
      [
        'a predicate answered with a boolean',
        replacing({ name: 'needs_human', value: false }),
      ],
      [
        'a probability above 1',
        replacing({ name: 'needs_human', probability: 1.2 }),
      ],
      [
        'a probability below 0',
        replacing({ name: 'needs_human', probability: -0.1 }),
      ],
      [
        'a choice outside the values',
        replacing({ name: 'route', choice: 'legal' }),
      ],
      [
        'a score above the top level',
        replacing({ name: 'severity', score: 3 }),
      ],
      ['a negative score', replacing({ name: 'severity', score: -1 })],
      ['a score given as text', replacing({ name: 'severity', score: '1' })],
      [
        'a confidence above 1',
        replacing({ name: 'route', choice: 'billing', confidence: 1.5 }),
      ],
      [
        'a probability for a value outside the choices',
        replacing({
          name: 'route',
          choice: 'billing',
          probabilities: [{ value: 'legal', probability: 0.1 }],
        }),
      ],
      [
        'a probability for a level that does not exist',
        replacing({
          name: 'severity',
          score: 1,
          probabilities: [{ value: 3, probability: 0.1 }],
        }),
      ],
      [
        'a probability for a fractional level',
        replacing({
          name: 'severity',
          score: 1,
          probabilities: [{ value: 1.5, probability: 0.1 }],
        }),
      ],
      [
        'a value given two probabilities',
        replacing({
          name: 'route',
          choice: 'billing',
          probabilities: [
            { value: 'billing', probability: 0.5 },
            { value: 'billing', probability: 0.5 },
          ],
        }),
      ],
      [
        'a probability entry with a field outside the contract',
        replacing({
          name: 'route',
          choice: 'billing',
          probabilities: [
            { value: 'billing', label: 'Billing', probability: 0.8 },
          ],
        }),
      ],
      [
        'probabilities that are not an array',
        replacing({
          name: 'severity',
          score: 1,
          probabilities: { '0': 0.1, '1': 0.8, '2': 0.1 },
        }),
      ],
    ])('%s fails the decision as invalid', async (_label, body) => {
      const decider = await deciderAnswering(`/invalid-${unique('x')}`, {
        body,
      });

      const res = await decide({ decider });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('failed');
      expect(res.body.answers).toBeNull();
      expect(res.body.answers_by_name).toBeNull();
      expect(res.body.error.code).toBe('DECISION_ANSWER_INVALID');
    });

    test('a tool error fails the decision with the tool’s code', async () => {
      const decider = await deciderAnswering('/down', {
        status: 529,
        body: { error: 'overloaded' },
      });

      const res = await decide({ decider });

      expect(res.body.status).toBe('failed');
      expect(res.body.error.code).toBe('TOOL_HTTP_ERROR');
    });

    test('an unreachable tool fails the decision', async () => {
      const closed = createServer();
      await new Promise<void>((resolve) => {
        closed.listen(0, '127.0.0.1', resolve);
      });
      const { port } = closed.address() as AddressInfo;
      await new Promise<void>((resolve) => {
        closed.close(() => {
          resolve();
        });
      });
      const decider = await createDecider({
        tool_id: await createTool({
          type: 'http',
          description: 'Nobody is listening',
          parameters: { type: 'object', additionalProperties: true },
          execute: { url: `http://127.0.0.1:${port}/gone`, method: 'POST' },
        }),
      });

      const res = await decide({ decider });

      expect(res.body.status).toBe('failed');
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
    });

    test('a tool that came to pin the questions is refused before any decision is written', async () => {
      const toolId = await createHttpTool('/engine');
      const decider = await createDecider({ tool_id: toolId });
      const update = await authenticatedTestClient(userToken)
        .patch(`/api/v1/tools/${toolId}`)
        .send({ preset_parameters: { questions: {} } });
      expect(update.status).toBe(200);

      const res = await decide({ decider });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('DECIDER_TOOL_NOT_CALLABLE');
      expect(await db.Decision.count({ where: { deciderId: decider } })).toBe(
        0
      );
    });

    test('an exhausted generation quota does not refuse a tool-backed decision', async () => {
      const fresh = await freshProjectAndAgent({
        adminToken,
        name: unique('decisions-tool-quota'),
      });
      const toolRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: fresh.projectPublicId,
          name: 'quota-engine',
          type: 'http',
          description: 'Answers a question set',
          parameters: { type: 'object', additionalProperties: true },
          execute: { url: `${stubBaseUrl}/engine`, method: 'POST' },
        });
      expect(toolRes.status).toBe(201);
      const deciderRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/deciders')
        .send({
          project_id: fresh.projectPublicId,
          name: 'quota-triage',
          tool_id: toolRes.body.id,
          questions: QUESTIONS,
        });
      expect(deciderRes.status).toBe(201);
      await seedUsageEvent({
        projectInternalId: fresh.projectInternalId,
        tokens: { input: 40, output: 40 },
      });
      await createQuotaRow({
        projectInternalId: fresh.projectInternalId,
        scope: 'project',
        metric: 'tokens',
        limit: 30,
      });

      const res = await decide({
        token: adminToken,
        decider: deciderRes.body.id,
      });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('completed');
    });
  });
  describe('a builtin step in the tool acts as the requester', () => {
    /**
     * A pipeline whose inline builtin step reads a decider named in the input,
     * and answers from what it read: the answer exists only if the step's
     * self-call carried a credential allowed to make it.
     */
    const createLookupDecider = async () => {
      const toolId = await createTool({
        type: 'pipeline',
        description: 'Answers from a decider it reads',
        pipeline: {
          steps: [
            {
              id: 'lookup',
              tool: {
                name: 'read-decider',
                type: 'builtin',
                actions: ['get-decider'],
              },
              action: 'get-decider',
              input: { decider_id: { var: 'input.input.decider_id' } },
            },
          ],
          output: {
            answers: [
              {
                name: 'route',
                choice: {
                  if: [
                    { '==': [{ var: 'steps.lookup.version' }, 1] },
                    'billing',
                    'technical',
                  ],
                },
              },
              { name: 'severity', score: 0 },
              { name: 'needs_human', probability: 0 },
            ],
          },
        },
      });
      return createDecider({ tool_id: toolId });
    };

    const inputFor = (decider: string) => {
      return { decider_id: decider };
    };

    test('wait: true answers from the step’s read', async () => {
      const decider = await createLookupDecider();

      const res = await decide({ decider, body: { input: inputFor(decider) } });

      expect(res.status).toBe(201);
      expect(res.body.error).toBeNull();
      expect(res.body.status).toBe('completed');
      expect(res.body.answers_by_name.route.choice).toBe('billing');
    });

    test('wait: false settles from the step’s read', async () => {
      const decider = await createLookupDecider();

      const res = await decide({
        decider,
        body: { input: inputFor(decider), wait: false },
      });

      expect(res.status).toBe(201);
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const row = await db.Decision.findOne({
          where: { publicId: res.body.id },
        });
        if (row && row.status !== 'queued' && row.status !== 'running') {
          expect(row.error).toBeNull();
          expect(row.status).toBe('completed');
          return;
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 25);
        });
      }
      throw new Error('The decision never settled.');
    });

    test('a requester who may not read what the step reads gets a failed decision', async () => {
      const decider = await createLookupDecider();
      const narrowToken = await createScopedPrincipal({
        adminToken,
        projectId,
        username: unique('decider-narrow'),
        actions: ['deciders:CreateDecision'],
      });

      const res = await decide({
        decider,
        token: narrowToken,
        body: { input: inputFor(decider) },
      });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('failed');
      expect(res.body.error.code).toBe('PIPELINE_STEP_FAILED');
      // A read the caller may not make answers as if the decider did not exist.
      expect(res.body.error.message).toMatch(/HTTP 404/);
    });
  });
});
