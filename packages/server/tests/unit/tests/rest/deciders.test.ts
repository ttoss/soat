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

const QUESTIONS = {
  route: {
    type: 'choice',
    instructions: 'Which team should own this ticket?',
    criteria: {
      billing: 'Charges, refunds, invoices, plan changes',
      technical: 'Errors, outages, integration failures',
    },
  },
  severity: {
    type: 'score',
    instructions: 'How urgent is this ticket?',
    criteria: [
      'Cosmetic or informational',
      'Workaround exists',
      'Blocks one workflow for one customer',
    ],
  },
  needs_human: {
    type: 'boolean',
    instructions: 'Must a person read this before any automated reply?',
    criteria: {
      false: 'Routine request an automated reply can answer',
      true: 'Churn threat, legal action or a security report',
    },
  },
};

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

    test('a boolean question may omit its criteria', async () => {
      const res = await createDecider(userToken, {
        questions: {
          escalate: { type: 'boolean', instructions: 'Escalate this?' },
        },
      });

      expect(res.status).toBe(201);
      expect(res.body.questions.escalate).toEqual({
        type: 'boolean',
        instructions: 'Escalate this?',
      });
    });

    test.each([
      ['no questions', {}],
      ['an unknown type', { q: { type: 'text', instructions: 'x' } }],
      [
        'a choice with one option',
        { q: { type: 'choice', instructions: 'x', criteria: { a: 'A' } } },
      ],
      [
        'a choice with an empty description',
        {
          q: {
            type: 'choice',
            instructions: 'x',
            criteria: { a: 'A', b: '' },
          },
        },
      ],
      [
        'a score with one level',
        { q: { type: 'score', instructions: 'x', criteria: ['only'] } },
      ],
      [
        'boolean criteria with the wrong keys',
        {
          q: {
            type: 'boolean',
            instructions: 'x',
            criteria: { yes: 'Y', no: 'N' },
          },
        },
      ],
      ['a missing instruction', { q: { type: 'boolean' } }],
      [
        'a question id that is not an identifier',
        { 'needs.human': { type: 'boolean', instructions: 'x' } },
      ],
      [
        'an unknown question field',
        { q: { type: 'boolean', instructions: 'x', weight: 2 } },
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
          questions: {
            ...QUESTIONS,
            route: {
              ...QUESTIONS.route,
              criteria: { ...QUESTIONS.route.criteria, account: 'Login' },
            },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.version).toBe(2);
      expect(Object.keys(res.body.questions.route.criteria)).toEqual([
        'billing',
        'technical',
        'account',
      ]);
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
          questions: {
            escalate: { type: 'boolean', instructions: 'Escalate?' },
          },
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
        .send({ questions: { q: { type: 'score', instructions: 'x' } } });

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
    const rewordedQuestions = {
      ...QUESTIONS,
      needs_human: {
        type: 'boolean',
        instructions: 'Does a person have to see this first?',
      },
    };

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
