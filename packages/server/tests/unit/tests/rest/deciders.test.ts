import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

const DECIDER_ACTIONS = [
  'deciders:ListDeciders',
  'deciders:CreateDecider',
  'deciders:GetDecider',
  'deciders:UpdateDecider',
  'deciders:DeleteDecider',
  'deciders:ListDeciderVersions',
  'deciders:GetDeciderVersion',
  'deciders:RestoreDeciderVersion',
  'agents:DeleteAgent',
];

const ROUTE_CHOICES = [
  { value: 'billing', description: 'Charges, refunds, invoices, plan changes' },
  { value: 'technical', description: 'Errors, outages, integration failures' },
];

const QUESTIONS = [
  {
    type: 'choice',
    name: 'route',
    instructions: 'Which team should own this ticket?',
    choices: ROUTE_CHOICES,
  },
  {
    type: 'score',
    name: 'severity',
    instructions: 'How urgent is this ticket?',
    levels: [
      { label: 'Cosmetic', description: 'Cosmetic or informational' },
      { label: 'Minor', description: 'Workaround exists' },
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

const TWO_CHOICES = [
  { value: 'a', description: 'A' },
  { value: 'b', description: 'B' },
];

const TWO_LEVELS = [
  { label: 'Low', description: 'L' },
  { label: 'High', description: 'H' },
];

describe('Deciders', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let otherProjectId: string;
  let noPermToken: string;
  let providerId: string;
  let agentId: string;
  let otherProjectAgentId: string;
  let toolAgentId: string;
  let memoryAgentId: string;
  let seq = 0;

  const unique = (base: string): string => {
    seq += 1;
    return `${base}-${seq}`;
  };

  const createAgent = async (body: Record<string, unknown>) => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({ ai_provider_id: providerId, project_id: projectId, ...body });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const createDecider = (
    token: string,
    body: Record<string, unknown> = {},
    project = projectId
  ) => {
    return authenticatedTestClient(token)
      .post('/api/v1/deciders')
      .send({
        project_id: project,
        name: unique('triage'),
        agent_id: agentId,
        questions: QUESTIONS,
        ...body,
      });
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
              action: DECIDER_ACTIONS.filter((action) => {
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
    const setup = await setupProjectWithUsers({
      prefix: 'deciders',
      policyActions: DECIDER_ACTIONS,
      createOtherProject: true,
      createNoPermUser: true,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId!;
    noPermToken = setup.noPermToken!;

    const providerRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'deciders-provider',
        provider: 'ollama',
        default_model: 'stub-model',
      });
    expect(providerRes.status).toBe(201);
    providerId = providerRes.body.id;

    agentId = await createAgent({ name: 'deciders-judge' });

    const otherProviderRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: otherProjectId,
        name: 'deciders-other-provider',
        provider: 'ollama',
        default_model: 'stub-model',
      });
    const otherAgentRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        ai_provider_id: otherProviderRes.body.id,
        project_id: otherProjectId,
        name: 'deciders-other-judge',
      });
    otherProjectAgentId = otherAgentRes.body.id;

    const toolRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'deciders-client-tool',
        type: 'client',
        parameters: { type: 'object', properties: {} },
      });
    expect(toolRes.status).toBe(201);
    toolAgentId = await createAgent({
      name: 'deciders-tool-agent',
      tool_bindings: [{ tool_id: toolRes.body.id }],
    });

    const storeRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/memory-stores')
      .send({ project_id: projectId, name: 'deciders-store' });
    expect(storeRes.status).toBe(201);
    memoryAgentId = await createAgent({
      name: 'deciders-memory-agent',
      knowledge_config: { write_memory_store_id: storeRes.body.id },
    });
  });

  describe('POST /api/v1/deciders', () => {
    test('creates a decider at version 1 and echoes its questions', async () => {
      const res = await createDecider(userToken, { description: 'Triage' });

      expect(res.status).toBe(201);
      expect(res.body.id).toMatch(/^dcd_/);
      expect(res.body.project_id).toBe(projectId);
      expect(res.body.agent_id).toBe(agentId);
      expect(res.body.description).toBe('Triage');
      expect(res.body.version).toBe(1);
      expect(res.body.questions).toEqual(QUESTIONS);
      expect(res.body.created_at).toBeDefined();
      expect(res.body.updated_at).toBeDefined();
    });

    test('keeps the order of questions, choices and levels', async () => {
      const reordered = [QUESTIONS[2], QUESTIONS[1], QUESTIONS[0]];

      const res = await createDecider(userToken, { questions: reordered });

      expect(res.status).toBe(201);
      expect(res.body.questions).toEqual(reordered);
    });

    test.each([
      ['no questions', undefined],
      ['an empty array', []],
      [
        'a map instead of an array',
        { q: { type: 'predicate', instructions: 'x' } },
      ],
      [
        'more than 20 questions',
        Array.from({ length: 21 }, (_, index) => {
          return { type: 'predicate', name: `q${index}`, instructions: 'x' };
        }),
      ],
      ['an unknown type', [{ type: 'text', name: 'q', instructions: 'x' }]],
      ['the boolean type', [{ type: 'boolean', name: 'q', instructions: 'x' }]],
      [
        'a choice with one choice',
        [
          {
            type: 'choice',
            name: 'q',
            instructions: 'x',
            choices: [{ value: 'a', description: 'A' }],
          },
        ],
      ],
      [
        'a choice with a criteria map',
        [
          {
            type: 'choice',
            name: 'q',
            instructions: 'x',
            criteria: { a: 'A', b: 'B' },
          },
        ],
      ],
      [
        'a choice with an empty description',
        [
          {
            type: 'choice',
            name: 'q',
            instructions: 'x',
            choices: [
              { value: 'a', description: 'A' },
              { value: 'b', description: '' },
            ],
          },
        ],
      ],
      [
        'a choice entry with an unknown field',
        [
          {
            type: 'choice',
            name: 'q',
            instructions: 'x',
            choices: [
              { value: 'a', description: 'A', weight: 2 },
              { value: 'b', description: 'B' },
            ],
          },
        ],
      ],
      [
        'a choice value declared twice',
        [
          {
            type: 'choice',
            name: 'q',
            instructions: 'x',
            choices: [
              { value: 'a', description: 'A' },
              { value: 'a', description: 'Again' },
            ],
          },
        ],
      ],
      [
        'a score with one level',
        [
          {
            type: 'score',
            name: 'q',
            instructions: 'x',
            levels: [{ label: 'Only', description: 'only' }],
          },
        ],
      ],
      [
        'a score level without a label',
        [
          {
            type: 'score',
            name: 'q',
            instructions: 'x',
            levels: [{ description: 'L' }, { label: 'High', description: 'H' }],
          },
        ],
      ],
      [
        'a predicate carrying choices',
        [
          {
            type: 'predicate',
            name: 'q',
            instructions: 'x',
            choices: TWO_CHOICES,
          },
        ],
      ],
      ['a missing instruction', [{ type: 'predicate', name: 'q' }]],
      ['a missing name', [{ type: 'predicate', instructions: 'x' }]],
      [
        'a name that is not an identifier',
        [{ type: 'predicate', name: 'needs.human', instructions: 'x' }],
      ],
      [
        'a name declared twice',
        [
          { type: 'predicate', name: 'q', instructions: 'x' },
          { type: 'score', name: 'q', instructions: 'y', levels: TWO_LEVELS },
        ],
      ],
      [
        'an unknown question field',
        [{ type: 'predicate', name: 'q', instructions: 'x', weight: 2 }],
      ],
    ])('rejects %s with 400', async (_label, questions) => {
      const res = await createDecider(userToken, { questions });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('rejects a missing agent_id with 400', async () => {
      const res = await createDecider(userToken, { agent_id: undefined });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('rejects an agent in another project with 400', async () => {
      const res = await createDecider(userToken, {
        agent_id: otherProjectAgentId,
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('AGENT_NOT_FOUND');
    });

    test('rejects an agent bound to a tool', async () => {
      const res = await createDecider(userToken, { agent_id: toolAgentId });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('DECIDER_AGENT_NOT_TOOL_LESS');
    });

    test('rejects an agent with an inline tool', async () => {
      const inlineAgentId = await createAgent({
        name: unique('inline-tool-agent'),
        tool_bindings: [
          {
            tool: {
              name: 'inline_lookup',
              type: 'client',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
      });

      const res = await createDecider(userToken, { agent_id: inlineAgentId });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('DECIDER_AGENT_NOT_TOOL_LESS');
      expect(res.body.error.meta.tools).toEqual(['inline_lookup']);
    });

    test('rejects an agent that writes memories', async () => {
      const res = await createDecider(userToken, { agent_id: memoryAgentId });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('DECIDER_AGENT_NOT_TOOL_LESS');
    });

    test('rejects a duplicate name in the project with 409', async () => {
      const name = unique('dupe');
      await createDecider(userToken, { name });

      const res = await createDecider(userToken, { name });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('NAME_CONFLICT');
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient
        .post('/api/v1/deciders')
        .send({ project_id: projectId, name: 'x' });
      expect(res.status).toBe(401);
    });

    test('user without the permission returns 403', async () => {
      const res = await createDecider(noPermToken);
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/v1/deciders', () => {
    test('lists the project’s deciders', async () => {
      const created = await createDecider(userToken);

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/deciders?project_id=${projectId}`
      );

      expect(res.status).toBe(200);
      expect(typeof res.body.total).toBe('number');
      expect(
        res.body.data.some((decider: { id: string }) => {
          return decider.id === created.body.id;
        })
      ).toBe(true);
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.get('/api/v1/deciders');
      expect(res.status).toBe(401);
    });

    test('user without the permission returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/deciders?project_id=${projectId}`
      );
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/v1/deciders/{decider_id}', () => {
    test('returns the decider', async () => {
      const created = await createDecider(userToken);

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/deciders/${created.body.id}`
      );

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(created.body.id);
      expect(res.body.questions).toEqual(QUESTIONS);
    });

    test('project-scoped key without GetDecider returns 404', async () => {
      const created = await createDecider(userToken);
      const key = await createRestrictedApiKey('deciders:GetDecider');

      const res = await authenticatedTestClient(key).get(
        `/api/v1/deciders/${created.body.id}`
      );

      expect(res.status).toBe(404);
    });

    test('unknown decider returns 404', async () => {
      const res = await authenticatedTestClient(userToken).get(
        '/api/v1/deciders/dcd_doesnotexist0000'
      );
      expect(res.status).toBe(404);
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.get('/api/v1/deciders/dcd_x');
      expect(res.status).toBe(401);
    });
  });

  describe('PATCH /api/v1/deciders/{decider_id}', () => {
    test('a rename leaves the version alone', async () => {
      const created = await createDecider(userToken);
      const name = unique('renamed');

      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/deciders/${created.body.id}`)
        .send({ name });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe(name);
      expect(res.body.version).toBe(1);
    });

    test('changing the questions bumps the version', async () => {
      const created = await createDecider(userToken);

      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/deciders/${created.body.id}`)
        .send({
          questions: [
            {
              ...QUESTIONS[0],
              choices: [
                ...ROUTE_CHOICES,
                { value: 'account', description: 'Login' },
              ],
            },
            QUESTIONS[1],
            QUESTIONS[2],
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.version).toBe(2);
      expect(
        res.body.questions[0].choices.map((choice: { value: string }) => {
          return choice.value;
        })
      ).toEqual(['billing', 'technical', 'account']);
    });

    test('rewriting identical questions leaves the version alone', async () => {
      const created = await createDecider(userToken);

      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/deciders/${created.body.id}`)
        .send({ questions: QUESTIONS });

      expect(res.status).toBe(200);
      expect(res.body.version).toBe(1);
    });

    test('a stale expected_version is refused with 409', async () => {
      const created = await createDecider(userToken);
      await authenticatedTestClient(userToken)
        .patch(`/api/v1/deciders/${created.body.id}`)
        .send({
          questions: [
            { type: 'predicate', name: 'escalate', instructions: 'Escalate?' },
          ],
        });

      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/deciders/${created.body.id}`)
        .send({ questions: QUESTIONS, expected_version: 1 });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('VERSION_CONFLICT');
    });

    test('invalid questions are refused with 400', async () => {
      const created = await createDecider(userToken);

      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/deciders/${created.body.id}`)
        .send({
          questions: [{ type: 'score', name: 'q', instructions: 'x' }],
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('repointing to an agent bound to a tool is refused', async () => {
      const created = await createDecider(userToken);

      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/deciders/${created.body.id}`)
        .send({ agent_id: toolAgentId });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('DECIDER_AGENT_NOT_TOOL_LESS');
    });

    test('project-scoped key without UpdateDecider returns 403', async () => {
      const created = await createDecider(userToken);
      const key = await createRestrictedApiKey('deciders:UpdateDecider');

      const res = await authenticatedTestClient(key)
        .patch(`/api/v1/deciders/${created.body.id}`)
        .send({ name: unique('nope') });

      expect(res.status).toBe(403);
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient
        .patch('/api/v1/deciders/dcd_x')
        .send({ name: 'x' });
      expect(res.status).toBe(401);
    });
  });

  describe('DELETE /api/v1/deciders/{decider_id}', () => {
    test('deletes the decider', async () => {
      const created = await createDecider(userToken);

      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/deciders/${created.body.id}`
      );
      expect(res.status).toBe(204);

      const after = await authenticatedTestClient(userToken).get(
        `/api/v1/deciders/${created.body.id}`
      );
      expect(after.status).toBe(404);
    });

    test('project-scoped key without DeleteDecider returns 403', async () => {
      const created = await createDecider(userToken);
      const key = await createRestrictedApiKey('deciders:DeleteDecider');

      const res = await authenticatedTestClient(key).delete(
        `/api/v1/deciders/${created.body.id}`
      );

      expect(res.status).toBe(403);
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.delete('/api/v1/deciders/dcd_x');
      expect(res.status).toBe(401);
    });
  });

  describe('versions', () => {
    const rewordedQuestions = [
      QUESTIONS[0],
      QUESTIONS[1],
      {
        type: 'predicate',
        name: 'needs_human',
        instructions: 'Does a person have to see this first?',
      },
    ];

    test('GET /api/v1/deciders/{decider_id}/versions lists every version newest first', async () => {
      const created = await createDecider(userToken);
      await authenticatedTestClient(userToken)
        .patch(`/api/v1/deciders/${created.body.id}`)
        .send({ questions: rewordedQuestions });

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/deciders/${created.body.id}/versions`
      );

      expect(res.status).toBe(200);
      expect(
        res.body.data.map((row: { version: number }) => {
          return row.version;
        })
      ).toEqual([2, 1]);
      expect(res.body.data[0].decider_id).toBe(created.body.id);
    });

    test('GET /api/v1/deciders/{decider_id}/versions/{version} returns the questions that version held', async () => {
      const created = await createDecider(userToken);
      await authenticatedTestClient(userToken)
        .patch(`/api/v1/deciders/${created.body.id}`)
        .send({ questions: rewordedQuestions });

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/deciders/${created.body.id}/versions/1`
      );

      expect(res.status).toBe(200);
      expect(res.body.version).toBe(1);
      expect(res.body.config.questions).toEqual(QUESTIONS);
    });

    test('POST /api/v1/deciders/{decider_id}/versions/{version}/restore appends the restored questions as a new version', async () => {
      const created = await createDecider(userToken);
      await authenticatedTestClient(userToken)
        .patch(`/api/v1/deciders/${created.body.id}`)
        .send({ questions: rewordedQuestions });

      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/deciders/${created.body.id}/versions/1/restore`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.version).toBe(3);
      expect(res.body.questions).toEqual(QUESTIONS);
    });

    test('an unknown version returns 404', async () => {
      const created = await createDecider(userToken);

      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/deciders/${created.body.id}/versions/9`
      );

      expect(res.status).toBe(404);
    });

    test('project-scoped key without ListDeciderVersions returns 404', async () => {
      const created = await createDecider(userToken);
      const key = await createRestrictedApiKey('deciders:ListDeciderVersions');

      const res = await authenticatedTestClient(key).get(
        `/api/v1/deciders/${created.body.id}/versions`
      );

      expect(res.status).toBe(404);
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.get('/api/v1/deciders/dcd_x/versions');
      expect(res.status).toBe(401);
    });
  });

  describe('the agent a decider points at', () => {
    test('cannot be deleted while the decider names it', async () => {
      const judgeId = await createAgent({ name: unique('pinned-judge') });
      await createDecider(userToken, { agent_id: judgeId });

      const res = await authenticatedTestClient(adminToken).delete(
        `/api/v1/agents/${judgeId}?force=true`
      );

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('AGENT_HAS_DEPENDENTS');
      expect(res.body.error.meta.decider_count).toBe(1);
    });
  });
});
