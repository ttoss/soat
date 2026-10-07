import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { db } from 'src/db';
import { eventBus, type SoatEvent } from 'src/lib/eventBus';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import {
  createQuotaRow,
  freshProjectAndAgent,
  seedUsageEvent,
} from '../../fixtures/quotaSeed';
import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient, testClient } from '../../testClient';

const DECISION_ACTIONS = [
  'deciders:CreateDecider',
  'deciders:UpdateDecider',
  'deciders:CreateDecision',
  'deciders:ListDecisions',
  'deciders:GetDecision',
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

const MODEL_ANSWER = { route: 'technical', severity: 2, needs_human: false };

const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

type ChatRequest = {
  messages: Array<{ role: string; content: string }>;
  response_format?: unknown;
};

describe('Decisions', () => {
  let stubServer: Server;
  let stubBaseUrl: string;
  const received: ChatRequest[] = [];
  let nextContent: string | undefined;
  // When set, the stub holds its answer until this promise resolves.
  let hold: Promise<void> | undefined;

  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let noPermToken: string;
  let providerId: string;
  let agentId: string;
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
        received.push(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
        const content = nextContent ?? JSON.stringify(MODEL_ANSWER);
        const answer = () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'chatcmpl-stub',
              object: 'chat.completion',
              created: 0,
              model: 'stub-model',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content },
                  finish_reason: 'stop',
                },
              ],
              usage: {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
              },
            })
          );
        };
        if (hold) {
          void hold.then(answer);
        } else {
          answer();
        }
      });
    });
    await new Promise<void>((resolve) => {
      stubServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = stubServer.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  const createAgent = async (body: Record<string, unknown>) => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({ ai_provider_id: providerId, project_id: projectId, ...body });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const createDecider = async (body: Record<string, unknown> = {}) => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/deciders')
      .send({
        project_id: projectId,
        name: unique('triage'),
        agent_id: agentId,
        questions: QUESTIONS,
        ...body,
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const decide = (args: {
    token?: string;
    decider?: string;
    body?: Record<string, unknown>;
  }) => {
    return authenticatedTestClient(args.token ?? userToken)
      .post(`/api/v1/deciders/${args.decider ?? deciderId}/decisions`)
      .send({ input: 'I was charged twice.', wait: true, ...args.body });
  };

  const countDecisions = async (decider: string): Promise<number> => {
    return db.Decision.count({ where: { deciderId: decider } });
  };

  /** Reads the decision until it settles, within a bound. */
  const waitForSettled = async (decisionId: string) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/decisions/${decisionId}`
      );
      if (res.body.status === 'completed' || res.body.status === 'failed') {
        return res;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25);
      });
    }
    throw new Error(`Decision ${decisionId} never settled.`);
  };

  const createRestrictedApiKey = async (
    excludedAction: string
  ): Promise<string> => {
    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: DECISION_ACTIONS.filter((action) => {
                return action !== excludedAction;
              }),
            },
          ],
        },
      });
    const keyRes = await authenticatedTestClient(userToken)
      .post('/api/v1/api-keys')
      .send({
        name: unique(`no-${excludedAction}`),
        project_id: projectId,
        policy_ids: [policyRes.body.id],
      });
    expect(keyRes.status).toBe(201);
    return keyRes.body.key as string;
  };

  beforeAll(async () => {
    stubBaseUrl = await startStubServer();

    const setup = await setupProjectWithUsers({
      prefix: 'decisions',
      policyActions: DECISION_ACTIONS,
      createOtherProject: false,
      createNoPermUser: true,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;
    noPermToken = setup.noPermToken!;

    const providerRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'decisions-provider',
        provider: 'ollama',
        default_model: 'stub-model',
        base_url: stubBaseUrl,
      });
    expect(providerRes.status).toBe(201);
    providerId = providerRes.body.id;

    agentId = await createAgent({
      name: 'decisions-judge',
      instructions: 'You triage support tickets for ACME.',
    });
    deciderId = await createDecider();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      stubServer.close(() => {
        resolve();
      });
    });
  });

  afterEach(() => {
    nextContent = undefined;
    hold = undefined;
  });

  describe('POST /api/v1/deciders/{decider_id}/decisions', () => {
    test('wait: true answers with the settled decision', async () => {
      const res = await decide({
        body: { metadata: { ticket_id: 'ZD-48213' } },
      });

      const answers = [
        { type: 'choice', name: 'route', choice: 'technical' },
        { type: 'score', name: 'severity', score: 2 },
        { type: 'predicate', name: 'needs_human', probability: 0 },
      ];
      expect(res.status).toBe(201);
      expect(res.body.id).toMatch(/^dec_/);
      expect(res.body.project_id).toBe(projectId);
      expect(res.body.decider_id).toBe(deciderId);
      expect(res.body.decider_version).toBe(1);
      expect(res.body.questions).toBeNull();
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

    test('a predicate the agent holds true is recorded with probability 1', async () => {
      nextContent = JSON.stringify({ ...MODEL_ANSWER, needs_human: true });

      const res = await decide({});

      expect(res.body.status).toBe('completed');
      expect(res.body.answers_by_name.needs_human).toEqual({
        type: 'predicate',
        name: 'needs_human',
        probability: 1,
      });
    });

    test('the model is shown the questions and the input, under the agent’s instructions', async () => {
      const before = received.length;

      await decide({ body: { input: 'The dashboard throws a 500.' } });

      const request = received[before];
      const system = request.messages.find((message) => {
        return message.role === 'system';
      });
      const user = request.messages.find((message) => {
        return message.role === 'user';
      });
      expect(system?.content).toContain('You triage support tickets for ACME.');
      expect(user?.content).toContain('Which team should own this ticket?');
      expect(user?.content).toContain(
        '- technical: Errors, outages, integration failures'
      );
      expect(user?.content).toContain(
        '- 2: Blocking. Blocks one workflow for one customer'
      );
      expect(user?.content).toContain('The dashboard throws a 500.');
      // The billing choice precedes the technical one, as the decider lists them.
      expect(user!.content.indexOf('billing:')).toBeLessThan(
        user!.content.indexOf('technical:')
      );
    });

    test('the answer space reaches the model as the output schema', async () => {
      const before = received.length;

      await decide({});

      const format = JSON.stringify(received[before].response_format);
      expect(format).toContain('"enum":["billing","technical"]');
      expect(format).toContain('"required":["route","severity","needs_human"]');
    });

    test('a structured input reaches the model as JSON', async () => {
      const before = received.length;

      await decide({
        body: { input: { subject: 'Refund', order_id: 'ord_778' } },
      });

      const user = received[before].messages.find((message) => {
        return message.role === 'user';
      });
      expect(user?.content).toContain('"order_id": "ord_778"');
    });

    test('a messages input reaches the model as its text parts', async () => {
      const before = received.length;

      const res = await decide({
        body: {
          input: [
            { role: 'user', content: 'I was charged twice.' },
            {
              role: 'user',
              content: [{ type: 'input_text', text: 'Order ord_778.' }],
            },
          ],
        },
      });

      expect(res.body.status).toBe('completed');
      const user = received[before].messages.find((message) => {
        return message.role === 'user';
      });
      expect(user?.content).toContain(
        '<input>\n\nI was charged twice.\n\nOrder ord_778.\n\n</input>'
      );
    });

    test('a messages input with an image reaches the agent as the frame and the image', async () => {
      const before = mockCreateGeneration.mock.calls.length;

      const res = await decide({
        body: {
          input: [
            {
              role: 'user',
              content: [
                { type: 'input_text', text: 'Is this box damaged?' },
                { type: 'input_image', image_url: PNG_DATA_URL },
              ],
            },
          ],
        },
      });

      expect(res.status).toBe(201);
      const [call] = mockCreateGeneration.mock.calls[before];
      expect(call.agentId).toBe(agentId);
      expect(call.messages).toEqual([
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: expect.stringContaining(
                '<input>\n\nIs this box damaged?\n\n</input>'
              ),
            },
            { type: 'image', image: PNG_DATA_URL },
          ],
        },
      ]);
    });

    test.each([
      ['a role other than user', [{ role: 'assistant', content: 'Hi.' }]],
      [
        'content that is neither text nor parts',
        [{ role: 'user', content: 42 }],
      ],
      [
        'a text part without text',
        [{ role: 'user', content: [{ type: 'input_text' }] }],
      ],
      [
        'an image that is not a base64 data URL',
        [
          {
            role: 'user',
            content: [
              {
                type: 'input_image',
                image_url: 'https://example.com/box.png',
              },
            ],
          },
        ],
      ],
      [
        'a part of an unknown type',
        [{ role: 'user', content: [{ type: 'input_audio', data: 'AAAA' }] }],
      ],
    ])(
      'a messages input with %s is refused before any decision is written',
      async (_label, input) => {
        const decider = await createDecider();

        const res = await decide({ decider, body: { input } });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
        expect(await countDecisions(decider)).toBe(0);
      }
    );

    // The frame's wording is not part of a decider's version, so a change to it
    // can move answers on an unchanged decider; pinning the exact text makes
    // every such change a reviewed diff.
    test('the model is shown the exact frame for every question type', async () => {
      const framed = await createDecider({
        questions: [
          {
            type: 'choice',
            name: 'route',
            instructions: 'Which team should own this ticket?',
            choices: [
              { value: 'billing', description: 'Charges' },
              { value: 'technical', description: 'Errors' },
            ],
          },
          {
            type: 'score',
            name: 'severity',
            instructions: 'How urgent is it?',
            levels: [
              { label: 'Cosmetic', description: 'Appearance only.' },
              { label: 'Blocking', description: 'No workaround.' },
            ],
          },
          {
            type: 'predicate',
            name: 'escalate',
            instructions: 'Does it threaten legal action?',
          },
        ],
      });
      nextContent = JSON.stringify({
        route: 'billing',
        severity: 1,
        escalate: false,
      });
      const before = received.length;

      const res = await decide({ decider: framed });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('completed');

      const user = received[before].messages.find((message) => {
        return message.role === 'user';
      });
      expect(user?.content).toBe(
        [
          'Answer every question below about the input that follows. Choose each answer only from the ones its question offers.',
          '## Questions',
          '### route (choice)\nWhich team should own this ticket?\nAnswer with one of these values:\n- billing: Charges\n- technical: Errors',
          '### severity (score)\nHow urgent is it?\nAnswer with the number of the level that fits:\n- 0: Cosmetic. Appearance only.\n- 1: Blocking. No workaround.',
          '### escalate (predicate)\nDoes it threaten legal action?\nAnswer true if the condition holds, false otherwise.',
          '## Input',
          '<input>',
          'I was charged twice.',
          '</input>',
        ].join('\n\n')
      );
    });

    test('wait: false answers queued, and the decision settles', async () => {
      const res = await decide({ body: { wait: false } });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('queued');
      expect(res.body.answers).toBeNull();
      expect(res.body.answers_by_name).toBeNull();

      const settled = await waitForSettled(res.body.id);
      expect(settled.body.status).toBe('completed');
      expect(settled.body.answers_by_name.route.choice).toBe('technical');
    });

    test('an answer outside the answer space fails the decision', async () => {
      nextContent = JSON.stringify({ ...MODEL_ANSWER, route: 'shipping' });

      const res = await decide({});

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('failed');
      expect(res.body.answers).toBeNull();
      expect(res.body.error.code).toBe('OUTPUT_SCHEMA_VALIDATION_FAILED');
    });

    test('names the question-set version it was answered under', async () => {
      const decider = await createDecider();
      const patched = await authenticatedTestClient(userToken)
        .patch(`/api/v1/deciders/${decider}`)
        .send({
          questions: [
            QUESTIONS[0],
            QUESTIONS[1],
            {
              type: 'predicate',
              name: 'needs_human',
              instructions: 'Does a person have to see this first?',
            },
          ],
        });
      expect(patched.status).toBe(200);

      const res = await decide({ decider });

      expect(res.body.decider_version).toBe(2);
    });

    test('its generation is metered with source decider', async () => {
      const res = await decide({});

      const events = await authenticatedTestClient(userToken).get(
        `/api/v1/usage/events?generation_id=${res.body.generation_id}`
      );
      expect(events.status).toBe(200);
      expect(events.body.data[0].source).toBe('decider');
    });

    test('settling fires decisions.completed once', async () => {
      const captured: SoatEvent[] = [];
      const handler = (event: SoatEvent) => {
        if (event.type.startsWith('decisions.')) captured.push(event);
      };
      eventBus.on('soat:event', handler);
      try {
        const res = await decide({});
        for (let tick = 0; tick < 100 && captured.length === 0; tick += 1) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 10);
          });
        }
        const mine = captured.filter((event) => {
          return event.resourceId === res.body.id;
        });
        expect(mine).toHaveLength(1);
        expect(mine[0].type).toBe('decisions.completed');
      } finally {
        eventBus.off('soat:event', handler);
      }
    });

    test('an agent that gained a tool after being named is refused before any decision is written', async () => {
      const judge = await createAgent({ name: unique('judge') });
      const decider = await createDecider({ agent_id: judge });
      const toolRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: unique('late-tool'),
          type: 'client',
          parameters: { type: 'object', properties: {} },
        });
      const patchRes = await authenticatedTestClient(adminToken)
        .put(`/api/v1/agents/${judge}`)
        .send({ tool_bindings: [{ tool_id: toolRes.body.id }] });
      expect(patchRes.status).toBe(200);

      const res = await decide({ decider });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('DECIDER_AGENT_NOT_TOOL_LESS');
      expect(await countDecisions(decider)).toBe(0);
    });

    test('a paused project refuses the decision before it is written', async () => {
      const decider = await createDecider();
      await authenticatedTestClient(adminToken)
        .post(`/api/v1/projects/${projectId}/pause`)
        .send({});
      try {
        const res = await decide({ decider });

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('PROJECT_PAUSED');
        expect(await countDecisions(decider)).toBe(0);
      } finally {
        await authenticatedTestClient(adminToken)
          .post(`/api/v1/projects/${projectId}/resume`)
          .send({});
      }
    });

    test('an exhausted quota refuses the decision before it is written', async () => {
      const fresh = await freshProjectAndAgent({
        adminToken,
        name: unique('decisions-quota'),
      });
      const deciderRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/deciders')
        .send({
          project_id: fresh.projectPublicId,
          name: 'quota-triage',
          agent_id: fresh.agentPublicId,
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

      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('QUOTA_EXCEEDED');
      expect(await countDecisions(deciderRes.body.id)).toBe(0);
    });

    test('a non-object metadata bag is refused with 400', async () => {
      const res = await decide({ body: { metadata: 'ZD-48213' } });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a missing input is refused with 400', async () => {
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/deciders/${deciderId}/decisions`)
        .send({ wait: true });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a state field is refused with 400', async () => {
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/deciders/${deciderId}/decisions`)
        .send({ state: 'I was charged twice.', wait: true });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a per-call question set is refused with 400', async () => {
      const res = await decide({ body: { questions: QUESTIONS } });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('an unknown decider returns 404', async () => {
      const res = await decide({ decider: 'dcd_doesnotexist0000' });
      expect(res.status).toBe(404);
    });

    test('project-scoped key without CreateDecision returns 403', async () => {
      const key = await createRestrictedApiKey('deciders:CreateDecision');

      const res = await decide({ token: key });

      expect(res.status).toBe(403);
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient
        .post(`/api/v1/deciders/${deciderId}/decisions`)
        .send({ input: 'x' });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/v1/agents/{agent_id}/generate', () => {
    test('takes no per-call output schema', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post(`/api/v1/agents/${agentId}/generate?wait=true`)
        .send({
          messages: [{ role: 'user', content: 'hello' }],
          output_schema: { type: 'object' },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('a background evaluation that cannot record its progress', () => {
    test('leaves the decision queued for the sweep', async () => {
      // Drives only the `.catch` on the detached evaluation, whose first write
      // moves the decision to `running`. Restored alone: restoring every mock
      // detaches the shared `mockCreateGeneration` spy.
      const update = jest
        .spyOn(db.Decision, 'update')
        .mockRejectedValueOnce(new Error('connection reset'));
      try {
        const res = await decide({ body: { wait: false } });
        expect(res.body.status).toBe('queued');
        for (
          let tick = 0;
          tick < 40 && update.mock.calls.length === 0;
          tick += 1
        ) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 25);
          });
        }

        expect(update).toHaveBeenCalled();
        const after = await authenticatedTestClient(userToken).get(
          `/api/v1/decisions/${res.body.id}`
        );
        expect(after.body.status).toBe('queued');
        expect(after.body.answers).toBeNull();
      } finally {
        update.mockRestore();
      }
    });
  });

  describe('an interrupted decision', () => {
    test('is settled failed by the sweep, and the late answer is discarded', async () => {
      let release = () => {};
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const res = await decide({ body: { wait: false } });
      expect(res.body.status).toBe('queued');

      const { sweepInterruptedDecisions } =
        await import('src/lib/decisionsScheduler');
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await sweepInterruptedDecisions({ now: future });

      const swept = await waitForSettled(res.body.id);
      expect(swept.body.status).toBe('failed');
      expect(swept.body.error.code).toBe('DECISION_INTERRUPTED');

      release();
      // The held generation now completes; its answer must not land.
      for (let tick = 0; tick < 40; tick += 1) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 25);
        });
      }
      const after = await authenticatedTestClient(userToken).get(
        `/api/v1/decisions/${res.body.id}`
      );
      expect(after.body.status).toBe('failed');
      expect(after.body.answers).toBeNull();
    });

    test('a decision still inside its lease is left alone', async () => {
      const res = await decide({});

      const { sweepInterruptedDecisions } =
        await import('src/lib/decisionsScheduler');
      const claimed = await sweepInterruptedDecisions({ now: new Date() });

      expect(claimed).toBe(0);
      const after = await authenticatedTestClient(userToken).get(
        `/api/v1/decisions/${res.body.id}`
      );
      expect(after.body.status).toBe('completed');
    });
  });

  describe('GET /api/v1/decisions', () => {
    test('lists the project’s decisions, filtered by decider and status', async () => {
      const decider = await createDecider();
      const made = await decide({ decider });

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/decisions?project_id=${projectId}&decider_id=${decider}&status=completed`
      );

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.data[0].id).toBe(made.body.id);
    });

    test('an admin lists across projects when no project is named', async () => {
      const decider = await createDecider();
      const made = await decide({ decider });

      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/decisions?decider_id=${decider}`
      );

      expect(res.status).toBe(200);
      expect(res.body.data[0].id).toBe(made.body.id);
    });

    test('a repeated status filter is refused with 400', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/decisions?project_id=${projectId}&status=queued&status=failed`
      );
      expect(res.status).toBe(400);
    });

    test('a status filter outside the vocabulary is refused with 400', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/decisions?project_id=${projectId}&status=done`
      );
      expect(res.status).toBe(400);
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.get('/api/v1/decisions');
      expect(res.status).toBe(401);
    });

    test('user without the permission returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/decisions?project_id=${projectId}`
      );
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/v1/decisions/{decision_id}', () => {
    test('returns the decision', async () => {
      const made = await decide({});

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/decisions/${made.body.id}`
      );

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(made.body.id);
      expect(res.body.status).toBe('completed');
    });

    test('outlives the decider that asked', async () => {
      const decider = await createDecider();
      const made = await decide({ decider });
      await authenticatedTestClient(adminToken).delete(
        `/api/v1/deciders/${decider}`
      );

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/decisions/${made.body.id}`
      );

      expect(res.status).toBe(200);
      expect(res.body.decider_id).toBe(decider);
    });

    test('project-scoped key without GetDecision returns 404', async () => {
      const made = await decide({});
      const key = await createRestrictedApiKey('deciders:GetDecision');

      const res = await authenticatedTestClient(key).get(
        `/api/v1/decisions/${made.body.id}`
      );

      expect(res.status).toBe(404);
    });

    test('unknown decision returns 404', async () => {
      const res = await authenticatedTestClient(userToken).get(
        '/api/v1/decisions/dec_doesnotexist0000'
      );
      expect(res.status).toBe(404);
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.get('/api/v1/decisions/dec_x');
      expect(res.status).toBe(401);
    });
  });
});
