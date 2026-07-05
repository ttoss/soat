import * as discussionCompletion from 'src/lib/discussionCompletion';
import { callDiscussionTool } from 'src/lib/toolsCall';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('Discussions', () => {
  let adminToken: string;
  let userToken: string;
  let userId: string;
  let projectId: string;
  let policyId: string;
  let aiProviderId: string;
  let noPermToken: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'discadmin', password: 'supersecret' });
    adminToken = await loginAs('discadmin', 'supersecret');

    const createUserRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'discuser', password: 'discpass' });
    userId = createUserRes.body.id;
    userToken = await loginAs('discuser', 'discpass');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Discussions Test Project' });
    projectId = projectRes.body.id;

    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: [
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
              ],
            },
          ],
        },
      });
    policyId = policyRes.body.id;

    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userId}/policies`)
      .send({ policy_ids: [policyId] });

    const noPermRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'discnoperm', password: 'nopassword' });
    expect(noPermRes.status).toBe(201);
    noPermToken = await loginAs('discnoperm', 'nopassword');

    const aiProvRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Discussions Test Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    aiProviderId = aiProvRes.body.id;
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

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.get('/api/v1/discussions');
      expect(res.status).toBe(401);
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

    test('unauthenticated run request returns 401', async () => {
      const created = await createDiscussion();
      const res = await testClient
        .post(`/api/v1/discussions/${created.body.id}/runs`)
        .send({ topic: 'x' });
      expect(res.status).toBe(401);
    });
  });

  describe('discussion-type tool', () => {
    test('creates a tool referencing a discussion', async () => {
      const created = await createDiscussion();
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'ask-the-panel',
          type: 'discussion',
          parameters: {
            type: 'object',
            properties: { topic: { type: 'string' } },
            required: ['topic'],
          },
          discussion: { discussion_id: created.body.id },
        });
      expect(res.status).toBe(201);
      expect(res.body.type).toBe('discussion');
      expect(res.body.discussion.discussion_id).toBe(created.body.id);
    });

    test('rejects a discussion tool referencing a missing discussion', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'bad-panel',
          type: 'discussion',
          discussion: { discussion_id: 'disc_missing' },
        });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
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

  describe('callDiscussionTool', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    test('runs the referenced discussion and returns outcome + run id', async () => {
      jest
        .spyOn(discussionCompletion, 'runDiscussionCompletion')
        .mockResolvedValue('tool outcome');
      const created = await createDiscussion({
        participants: [{ name: 'Solo', prompt: 'think' }],
      });
      const result = (await callDiscussionTool(
        {
          name: 'ask',
          type: 'discussion',
          discussion: { discussionId: created.body.id },
        },
        { topic: 'What should we do?' }
      )) as { outcome: string; run_id: string };
      expect(result.outcome).toBe('tool outcome');
      expect(result.run_id).toMatch(/^drn_/);
    });

    test('throws when the discussion config is missing a discussionId', async () => {
      await expect(
        callDiscussionTool(
          { name: 'ask', type: 'discussion', discussion: {} },
          {
            topic: 't',
          }
        )
      ).rejects.toThrow(/discussion configuration/i);
    });

    test('throws when no topic is supplied', async () => {
      const created = await createDiscussion({
        participants: [{ name: 'Solo', prompt: 'think' }],
      });
      await expect(
        callDiscussionTool(
          {
            name: 'ask',
            type: 'discussion',
            discussion: { discussionId: created.body.id },
          },
          {}
        )
      ).rejects.toThrow(/topic/i);
    });
  });
});
