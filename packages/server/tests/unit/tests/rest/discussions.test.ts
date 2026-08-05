import * as discussionCompletion from 'src/lib/discussionCompletion';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

describe('Discussions', () => {
  let adminToken: string;
  let userToken: string;
  let userId: string;
  let projectId: string;
  let policyId: string;
  let aiProviderId: string;
  let noPermToken: string;
  let scopedApiKey: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'disc',
      policyActions: [
        'discussions:CreateDiscussion',
        'discussions:ListDiscussions',
        'discussions:GetDiscussion',
        'discussions:UpdateDiscussion',
        'discussions:DeleteDiscussion',
        'discussions:CreateDiscussionRun',
        'discussions:ListDiscussionRuns',
        'discussions:GetDiscussionRun',
        'tools:CreateTool',
        'tools:GetTool',
        'tools:DeleteTool',
        'documents:GetDocument',
      ],
    });

    adminToken = setup.adminToken;
    userToken = setup.userToken;
    userId = setup.userId;
    projectId = setup.projectId;
    policyId = setup.policyId;
    noPermToken = setup.noPermToken as string;

    const aiProvRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Discussions Test Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    aiProviderId = aiProvRes.body.id;

    // Project-scoped API key for implicit-project tests.
    const keyRes = await authenticatedTestClient(userToken)
      .post('/api/v1/api-keys')
      .send({
        project_id: projectId,
        policy_ids: [policyId],
        name: 'Discussions scoped key',
      });
    expect(keyRes.status).toBe(201);
    scopedApiKey = keyRes.body.key;
  });

  const createDiscussion = (overrides: Record<string, unknown> = {}) => {
    return authenticatedTestClient(userToken)
      .post('/api/v1/discussions')
      .send({
        project_id: projectId,
        name: 'Design panel',
        ai_provider_id: aiProviderId,
        max_rounds: 1,
        participants: [
          { name: 'Advocate', prompt: 'Argue for the proposal.' },
          { name: 'Skeptic', prompt: 'Argue against the proposal.' },
        ],
        ...overrides,
      });
  };

  describe('POST /api/v1/discussions', () => {
    test('creates a discussion with participants', async () => {
      const res = await createDiscussion();
      expect(res.status).toBe(201);
      expect(res.body.id).toMatch(/^disc_/);
      expect(res.body.project_id).toBe(projectId);
      expect(res.body.ai_provider_id).toBe(aiProviderId);
      expect(res.body.participants).toHaveLength(2);
      expect(res.body.participants[0].id).toMatch(/^dpt_/);
      expect(res.body.participants[0].name).toBe('Advocate');
    });

    test('project-scoped API key resolves projectId automatically when omitted', async () => {
      const res = await authenticatedTestClient(scopedApiKey)
        .post('/api/v1/discussions')
        .send({
          name: 'Implicit project panel',
          ai_provider_id: aiProviderId,
        });
      expect(res.status).toBe(201);
      expect(res.body.id).toMatch(/^disc_/);
      expect(res.body.project_id).toBe(projectId);
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.post('/api/v1/discussions').send({
        project_id: projectId,
        name: 'x',
        ai_provider_id: aiProviderId,
      });
      expect(res.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .post('/api/v1/discussions')
        .send({
          project_id: projectId,
          name: 'x',
          ai_provider_id: aiProviderId,
        });
      expect(res.status).toBe(403);
    });

    test('rejects more than 5 participants', async () => {
      const res = await createDiscussion({
        participants: Array.from({ length: 6 }, (_, i) => {
          return { name: `P${i}` };
        }),
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_DISCUSSION_CONFIG');
    });

    test('rejects an invalid effort value', async () => {
      const res = await createDiscussion({
        participants: [{ name: 'P', effort: 'extreme' }],
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_DISCUSSION_CONFIG');
    });

    test('rejects an unknown ai provider', async () => {
      const res = await createDiscussion({ ai_provider_id: 'aip_missing' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('AI_PROVIDER_NOT_FOUND');
    });

    test('a participant prompt with only allowed tokens has no template_warnings', async () => {
      const res = await createDiscussion({
        participants: [
          { name: 'Advocate', prompt: 'Consider {topic} using {transcript}.' },
        ],
      });
      expect(res.status).toBe(201);
      expect(res.body.template_warnings).toEqual([]);
    });

    test('a participant prompt referencing an unknown token surfaces a template_warnings entry', async () => {
      const res = await createDiscussion({
        participants: [
          { name: 'Advocate', prompt: 'Summarize {steps.synthesis} please.' },
        ],
      });
      expect(res.status).toBe(201);
      expect(res.body.template_warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('{steps.synthesis}')])
      );
    });

    test('a synthesis prompt referencing {steps.deliberation} has no template_warnings', async () => {
      const res = await createDiscussion({
        synthesis: { prompt: 'Wrap up: {steps.deliberation.last}' },
      });
      expect(res.status).toBe(201);
      expect(res.body.template_warnings).toEqual([]);
    });
  });

  describe('GET /api/v1/discussions', () => {
    test('lists discussions in a project', async () => {
      await createDiscussion();
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/discussions?project_id=${projectId}`
      );
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.total).toBeGreaterThan(0);
    });

    test('lists discussions without a project_id filter', async () => {
      await createDiscussion();
      const res = await authenticatedTestClient(userToken).get(
        '/api/v1/discussions?limit=1&offset=0'
      );
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.get('/api/v1/discussions');
      expect(res.status).toBe(401);
    });

    test('user without permission scoped to project_id returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/discussions?project_id=${projectId}`
      );
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/v1/discussions/:id', () => {
    test('returns a discussion', async () => {
      const created = await createDiscussion();
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/discussions/${created.body.id}`
      );
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(created.body.id);
    });

    test('returns 404 for a missing discussion', async () => {
      const res = await authenticatedTestClient(userToken).get(
        '/api/v1/discussions/disc_missing'
      );
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });
  });

  describe('PATCH /api/v1/discussions/:id', () => {
    test('updates and replaces participants', async () => {
      const created = await createDiscussion();
      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/discussions/${created.body.id}`)
        .send({
          name: 'Renamed panel',
          participants: [{ name: 'Solo', prompt: 'Think alone.' }],
        });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Renamed panel');
      expect(res.body.participants).toHaveLength(1);
      expect(res.body.participants[0].name).toBe('Solo');
    });
  });

  describe('DELETE /api/v1/discussions/:id', () => {
    test('deletes a discussion', async () => {
      const created = await createDiscussion();
      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/discussions/${created.body.id}`
      );
      expect(res.status).toBe(204);
      const getRes = await authenticatedTestClient(userToken).get(
        `/api/v1/discussions/${created.body.id}`
      );
      expect(getRes.status).toBe(404);
    });
  });

  describe('POST /api/v1/discussions/:id/runs', () => {
    let spy: jest.SpyInstance;

    beforeEach(() => {
      spy = jest
        .spyOn(discussionCompletion, 'runDiscussionCompletion')
        .mockResolvedValue('The panel recommends proceeding.');
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    test('runs a discussion and returns the outcome', async () => {
      const created = await createDiscussion();
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/discussions/${created.body.id}/runs`)
        .send({ topic: 'Should we ship on Friday?' });
      expect(res.status).toBe(201);
      expect(res.body.id).toMatch(/^drn_/);
      expect(res.body.status).toBe('completed');
      expect(res.body.outcome).toBe('The panel recommends proceeding.');
      expect(res.body.topic).toBe('Should we ship on Friday?');
      expect(spy).toHaveBeenCalled();
    });

    test('requires a topic', async () => {
      const created = await createDiscussion();
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/discussions/${created.body.id}/runs`)
        .send({});
      expect(res.status).toBe(400);
    });

    test('non-string topic returns 400', async () => {
      const created = await createDiscussion();
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/discussions/${created.body.id}/runs`)
        .send({ topic: 123 });
      expect(res.status).toBe(400);
    });

    test('lists and gets runs', async () => {
      const created = await createDiscussion();
      const runRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/discussions/${created.body.id}/runs`)
        .send({ topic: 'Topic A' });
      expect(runRes.status).toBe(201);

      const listRes = await authenticatedTestClient(userToken).get(
        `/api/v1/discussions/${created.body.id}/runs`
      );
      expect(listRes.status).toBe(200);
      expect(listRes.body.total).toBeGreaterThan(0);

      const getRes = await authenticatedTestClient(userToken).get(
        `/api/v1/discussions/runs/${runRes.body.id}`
      );
      expect(getRes.status).toBe(200);
      expect(getRes.body.id).toBe(runRes.body.id);
    });

    test('getting a run without permission returns 403', async () => {
      const created = await createDiscussion();
      const runRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/discussions/${created.body.id}/runs`)
        .send({ topic: 'Topic B' });
      expect(runRes.status).toBe(201);

      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/discussions/runs/${runRes.body.id}`
      );
      expect(res.status).toBe(403);
    });

    test('unauthenticated run request returns 401', async () => {
      const created = await createDiscussion();
      const res = await testClient
        .post(`/api/v1/discussions/${created.body.id}/runs`)
        .send({ topic: 'x' });
      expect(res.status).toBe(401);
    });

    // #858: attribution is a typed, explicitly serialized principal pair — the
    // same vocabulary `Generation.started_by_principal_*` uses — not an opaque
    // `started_by` bag whose inner keys escaped the snake_case contract.
    describe('run attribution (#858)', () => {
      test('credits the JWT user as a typed principal pair', async () => {
        const created = await createDiscussion();
        const res = await authenticatedTestClient(userToken)
          .post(`/api/v1/discussions/${created.body.id}/runs`)
          .send({ topic: 'Who started this?' });

        expect(res.status).toBe(201);
        expect(res.body.started_by_principal_type).toBe('user');
        expect(res.body.started_by_principal_id).toBe(userId);
        // The opaque bag and the never-populated reserved field are both gone.
        expect(res.body.started_by).toBeUndefined();
        expect(res.body.initiator_generation_id).toBeUndefined();
      });

      test('credits the API key itself when a key starts the run', async () => {
        const created = await createDiscussion();
        const res = await authenticatedTestClient(scopedApiKey)
          .post(`/api/v1/discussions/${created.body.id}/runs`)
          .send({ topic: 'Started by a key' });

        expect(res.status).toBe(201);
        expect(res.body.started_by_principal_type).toBe('api_key');
        expect(res.body.started_by_principal_id).toMatch(/^key_/);
      });

      test('attribution survives on the read paths', async () => {
        const created = await createDiscussion();
        const runRes = await authenticatedTestClient(userToken)
          .post(`/api/v1/discussions/${created.body.id}/runs`)
          .send({ topic: 'Readback' });
        expect(runRes.status).toBe(201);

        const getRes = await authenticatedTestClient(userToken).get(
          `/api/v1/discussions/runs/${runRes.body.id}`
        );
        expect(getRes.status).toBe(200);
        expect(getRes.body.started_by_principal_type).toBe('user');
        expect(getRes.body.started_by_principal_id).toBe(userId);

        const listRes = await authenticatedTestClient(userToken).get(
          `/api/v1/discussions/${created.body.id}/runs`
        );
        expect(listRes.status).toBe(200);
        const listed = listRes.body.data.find((run: { id: string }) => {
          return run.id === runRes.body.id;
        });
        expect(listed.started_by_principal_type).toBe('user');
        expect(listed.started_by_principal_id).toBe(userId);
      });

      test('a caller cannot forge the attribution through the request body', async () => {
        const created = await createDiscussion();
        const res = await authenticatedTestClient(userToken)
          .post(`/api/v1/discussions/${created.body.id}/runs`)
          .send({
            topic: 'Forgery attempt',
            started_by_principal_type: 'api_key',
            started_by_principal_id: 'key_forged',
            started_by: { userId: 'usr_forged' },
          });

        // `strictFields` rejects the undeclared fields outright; the point is
        // that no path exists for a caller to set the attribution.
        expect(res.status).toBe(400);
      });
    });
  });

  describe('invoking a discussion from a tool', () => {
    // The `discussion` tool type was removed; a discussion is invoked from an
    // agent or an orchestration through a `soat` tool bound to
    // `create-discussion-run`, which runs the ordinary REST route and so is
    // subject to discussions:CreateDiscussionRun like any other caller.
    test('creates a soat tool bound to create-discussion-run with the discussion pinned', async () => {
      const created = await createDiscussion();
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'ask-the-panel',
          type: 'soat',
          actions: ['create-discussion-run'],
          preset_parameters: { discussion_id: created.body.id },
        });
      expect(res.status).toBe(201);
      expect(res.body.type).toBe('soat');
      expect(res.body.actions).toEqual(['create-discussion-run']);
      // Pinning the id here is what keeps `discussion_id` out of the schema the
      // model sees, leaving `topic` as the only argument it supplies.
      expect(res.body.preset_parameters).toEqual({
        discussion_id: created.body.id,
      });
      expect(res.body.discussion_id).toBeUndefined();
    });

    test('rejects the removed discussion tool type', async () => {
      const created = await createDiscussion();
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'ask-the-panel-legacy',
          type: 'discussion',
          preset_parameters: { discussion_id: created.body.id },
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.message).toMatch(/unsupported tool type/i);
    });
  });

  describe('config variants', () => {
    test('creates a discussion with a synthesis override and participant effort', async () => {
      const res = await createDiscussion({
        synthesis: {
          ai_provider_id: aiProviderId,
          prompt: 'Weigh {steps.deliberation}',
          effort: 'high',
        },
        participants: [
          { name: 'A', prompt: 'a', effort: 'low' },
          { name: 'B', prompt: 'b', model: 'llama3.2', temperature: 0.5 },
        ],
      });
      expect(res.status).toBe(201);
      expect(res.body.synthesis.effort).toBe('high');
      expect(res.body.participants[0].effort).toBe('low');
    });

    test('rejects a synthesis referencing an unknown provider', async () => {
      const res = await createDiscussion({
        synthesis: { ai_provider_id: 'aip_missing' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('AI_PROVIDER_NOT_FOUND');
    });
  });

  describe('authorization', () => {
    let discussionId: string;

    beforeAll(async () => {
      const created = await createDiscussion();
      discussionId = created.body.id;
    });

    test('unauthenticated get/patch/delete/runs return 401', async () => {
      expect(
        (await testClient.get(`/api/v1/discussions/${discussionId}`)).status
      ).toBe(401);
      expect(
        (
          await testClient
            .patch(`/api/v1/discussions/${discussionId}`)
            .send({ name: 'x' })
        ).status
      ).toBe(401);
      expect(
        (await testClient.delete(`/api/v1/discussions/${discussionId}`)).status
      ).toBe(401);
      expect(
        (await testClient.get(`/api/v1/discussions/${discussionId}/runs`))
          .status
      ).toBe(401);
      expect(
        (await testClient.get('/api/v1/discussions/runs/drn_x')).status
      ).toBe(401);
    });

    test('user without permission is forbidden on every endpoint', async () => {
      const client = authenticatedTestClient(noPermToken);
      expect(
        (await client.get(`/api/v1/discussions/${discussionId}`)).status
      ).toBe(403);
      expect(
        (
          await client
            .patch(`/api/v1/discussions/${discussionId}`)
            .send({ name: 'x' })
        ).status
      ).toBe(403);
      expect(
        (await client.delete(`/api/v1/discussions/${discussionId}`)).status
      ).toBe(403);
      expect(
        (
          await client
            .post(`/api/v1/discussions/${discussionId}/runs`)
            .send({ topic: 't' })
        ).status
      ).toBe(403);
      expect(
        (await client.get(`/api/v1/discussions/${discussionId}/runs`)).status
      ).toBe(403);
    });
  });

  describe('run variants', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    test('a single-participant discussion returns its lone turn as the outcome', async () => {
      jest
        .spyOn(discussionCompletion, 'runDiscussionCompletion')
        .mockResolvedValue('solo outcome');
      const created = await createDiscussion({
        participants: [{ name: 'Solo', prompt: 'think' }],
      });
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/discussions/${created.body.id}/runs`)
        .send({ topic: 'Q' });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('completed');
      expect(res.body.outcome).toBe('solo outcome');
      // Transcript/outcome persistence is best-effort; when it succeeds the run
      // links a conversation + document, otherwise those stay null.
      if (res.body.conversation_id !== null) {
        expect(res.body.conversation_id).toMatch(/^conv_/);
        expect(res.body.outcome_document_id).toMatch(/^doc_/);

        // The outcome document must be distinguishable from real project
        // knowledge (issue: discussion outputs pollute search-knowledge) —
        // it carries a /discussions/ path and identifying metadata/tags.
        const docRes = await authenticatedTestClient(userToken).get(
          `/api/v1/documents/${res.body.outcome_document_id}`
        );
        expect(docRes.status).toBe(200);
        expect(docRes.body.path).toMatch(
          new RegExp(`^/discussions/${created.body.id}/runs/${res.body.id}/`)
        );
        expect(docRes.body.metadata).toMatchObject({
          source: 'discussion-run',
          discussionId: created.body.id,
          runId: res.body.id,
        });
        expect(docRes.body.tags).toMatchObject({ source: 'discussion' });
      }
    });

    test('an all-failed run is marked failed with no persisted artifacts', async () => {
      jest
        .spyOn(discussionCompletion, 'runDiscussionCompletion')
        .mockRejectedValue(new Error('provider down'));
      const created = await createDiscussion({
        participants: [{ name: 'Solo', prompt: 'think' }],
      });
      const res = await authenticatedTestClient(userToken)
        .post(`/api/v1/discussions/${created.body.id}/runs`)
        .send({ topic: 'Q' });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('failed');
      expect(res.body.conversation_id).toBeNull();
    });

    test('get-run returns 404 for a missing run', async () => {
      const res = await authenticatedTestClient(userToken).get(
        '/api/v1/discussions/runs/drn_missing'
      );
      expect(res.status).toBe(404);
    });
  });
});
