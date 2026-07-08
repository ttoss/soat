import { db } from 'src/db';
import { saveTrace } from 'src/lib/traces';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

describe('Traces REST API', () => {
  let adminToken: string;
  let userToken: string;
  let noPermToken: string;
  let userId: string;
  let projectId: string;
  let traceId: string;
  let childTraceId: string;
  let traceGenerationIds: string[];
  let childGenerationId: string;
  let tracesAgentDbId: number;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'tracesadmin', password: 'supersecret' });

    adminToken = await loginAs('tracesadmin', 'supersecret');

    const createUserRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'tracesuser', password: 'tracespass' });

    userId = createUserRes.body.id;
    userToken = await loginAs('tracesuser', 'tracespass');

    const noPermRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'tracesnoperm', password: 'nopassword' });
    expect(noPermRes.status).toBe(201);
    noPermToken = await loginAs('tracesnoperm', 'nopassword');

    // Create a project
    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Traces Test Project' });

    projectId = projectRes.body.id;

    // Grant traces permissions to user
    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: [
                'traces:ListTraces',
                'traces:GetTrace',
                'traces:GetTraceTree',
                'generations:ListGenerations',
              ],
            },
          ],
        },
      });

    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userId}/policies`)
      .send({ policy_ids: [policyRes.body.id] });

    // Seed a root trace via lib
    traceId = `trc_rest_root_${Date.now()}`;
    childTraceId = `trc_rest_child_${Date.now()}`;

    // Get internal projectId from DB for saveTrace
    const project = await db.Project.findOne({
      where: { publicId: projectId },
    });
    const internalProjectId = project?.id as number;

    const aiProvider = await db.AiProvider.create({
      projectId: internalProjectId,
      name: 'Traces REST Provider',
      provider: 'openai',
      defaultModel: 'gpt-4o-mini',
      baseUrl: null,
      config: null,
      secretId: null,
    });

    const tracesAgent = await db.Agent.create({
      publicId: 'agt_traces_rest_001',
      projectId: internalProjectId,
      aiProviderId: aiProvider.id,
      name: 'Traces Agent 1',
    });

    tracesAgentDbId = tracesAgent.id;

    await db.Agent.create({
      publicId: 'agt_traces_rest_002',
      projectId: internalProjectId,
      aiProviderId: aiProvider.id,
      name: 'Traces Agent 2',
    });

    await saveTrace({
      traceId,
      projectId: internalProjectId,
      projectPublicId: projectId,
      agentId: 'agt_traces_rest_001',
      steps: [{ type: 'text-delta', text: 'hello' }],
    });

    await saveTrace({
      traceId: childTraceId,
      projectId: internalProjectId,
      projectPublicId: projectId,
      agentId: 'agt_traces_rest_002',
      steps: [{ type: 'text-delta', text: 'world' }],
      parentTraceId: traceId,
      rootTraceId: traceId,
    });

    const rootTrace = await db.Trace.findOne({
      where: { publicId: traceId, projectId: internalProjectId },
    });

    expect(rootTrace).toBeTruthy();

    const firstGenerationId = `gen_rest_1_${Date.now()}`;
    const secondGenerationId = `gen_rest_2_${Date.now()}`;

    await db.Generation.create({
      publicId: firstGenerationId,
      projectId: internalProjectId,
      agentId: tracesAgentDbId,
      traceId: rootTrace!.id,
      initiatorGenerationId: null,
      startedByActorId: null,
      startedByPrincipalType: null,
      startedByPrincipalId: null,
      status: 'completed',
      startedAt: new Date(Date.now() - 2000),
      completedAt: new Date(Date.now() - 1500),
      lastActivityAt: new Date(Date.now() - 1500),
      stopReason: 'stop',
      metadata: null,
    });

    await db.Generation.create({
      publicId: secondGenerationId,
      projectId: internalProjectId,
      agentId: tracesAgentDbId,
      traceId: rootTrace!.id,
      initiatorGenerationId: null,
      startedByActorId: null,
      startedByPrincipalType: null,
      startedByPrincipalId: null,
      status: 'completed',
      startedAt: new Date(Date.now() - 1000),
      completedAt: new Date(Date.now() - 500),
      lastActivityAt: new Date(Date.now() - 500),
      stopReason: 'stop',
      metadata: null,
    });

    traceGenerationIds = [firstGenerationId, secondGenerationId];

    // Create a child generation linked to the first generation (simulates debate child)
    const firstGen = await db.Generation.findOne({
      where: { publicId: firstGenerationId },
    });
    childGenerationId = `gen_rest_child_${Date.now()}`;
    await db.Generation.create({
      publicId: childGenerationId,
      projectId: internalProjectId,
      agentId: tracesAgentDbId,
      traceId: rootTrace!.id,
      initiatorGenerationId: firstGen!.id,
      startedByActorId: null,
      startedByPrincipalType: null,
      startedByPrincipalId: null,
      status: 'completed',
      startedAt: new Date(Date.now() - 400),
      completedAt: new Date(Date.now() - 200),
      lastActivityAt: new Date(Date.now() - 200),
      stopReason: 'stop',
      metadata: {
        discussion: {
          participant: 'Advocate',
          round: 0,
          output: 'advocate text',
        },
      },
    });
  });

  describe('GET /api/v1/traces', () => {
    test('unauthenticated request returns 401', async () => {
      const res = await testClient.get('/api/v1/traces');
      expect(res.status).toBe(401);
    });

    test('authenticated user with permission can list traces', async () => {
      const res = await authenticatedTestClient(userToken)
        .get('/api/v1/traces')
        .query({ projectId });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(typeof res.body.total).toBe('number');
      expect(typeof res.body.limit).toBe('number');
      expect(typeof res.body.offset).toBe('number');
    });

    test('returns seeded trace in results', async () => {
      const res = await authenticatedTestClient(userToken)
        .get('/api/v1/traces')
        .query({ projectId });
      expect(res.status).toBe(200);
      const ids = res.body.data.map((t: { id: string }) => {
        return t.id;
      });
      expect(ids).toContain(traceId);
    });

    test('user without permission cannot list traces', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .get('/api/v1/traces')
        .query({ projectId });
      expect(res.status).toBe(403);
    });

    test('accepts limit and offset query params', async () => {
      const res = await authenticatedTestClient(userToken)
        .get('/api/v1/traces')
        .query({ projectId, limit: 1, offset: 0 });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });

  describe('GET /api/v1/traces/:trace_id', () => {
    test('unauthenticated request returns 401', async () => {
      const res = await testClient.get(`/api/v1/traces/${traceId}`);
      expect(res.status).toBe(401);
    });

    test('authenticated user can get a trace', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/traces/${traceId}`
      );
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(traceId);
      expect(res.body.project_id).toBe(projectId);
      expect(res.body.step_count).toBe(1);
      expect(res.body.parent_trace_id).toBeNull();
      expect(res.body.root_trace_id).toBeNull();
    });

    test('returns 404 for non-existent trace', async () => {
      const res = await authenticatedTestClient(userToken).get(
        '/api/v1/traces/trc_nonexistent_000000'
      );
      expect(res.status).toBe(404);
    });

    test('child trace has parent_trace_id set', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/traces/${childTraceId}`
      );
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(childTraceId);
      expect(res.body.parent_trace_id).toBe(traceId);
      expect(res.body.root_trace_id).toBe(traceId);
    });

    test('project-scoped API key without GetTrace permission returns 403', async () => {
      const policyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [{ effect: 'Allow', action: ['traces:ListTraces'] }],
          },
        });
      const keyRes = await authenticatedTestClient(userToken)
        .post('/api/v1/api-keys')
        .send({
          name: 'No GetTrace Key',
          project_id: projectId,
          policy_ids: [policyRes.body.id],
        });
      expect(keyRes.status).toBe(201);

      const res = await authenticatedTestClient(keyRes.body.key as string).get(
        `/api/v1/traces/${traceId}`
      );
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/v1/traces/:trace_id/tree', () => {
    test('unauthenticated request returns 401', async () => {
      const res = await testClient.get(`/api/v1/traces/${traceId}/tree`);
      expect(res.status).toBe(401);
    });

    test('authenticated user can get trace tree', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/traces/${traceId}/tree`
      );
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(traceId);
      expect(Array.isArray(res.body.children)).toBe(true);
      expect(res.body.children).toHaveLength(1);
      expect(res.body.children[0].id).toBe(childTraceId);
    });

    test('returns 404 for non-existent trace', async () => {
      const res = await authenticatedTestClient(userToken).get(
        '/api/v1/traces/trc_nonexistent_000000/tree'
      );
      expect(res.status).toBe(404);
    });

    test('leaf trace returns node with empty children', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/traces/${childTraceId}/tree`
      );
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(traceId);
      expect(res.body.children).toHaveLength(1);
    });

    test('project-scoped API key without GetTraceTree permission returns 403', async () => {
      const policyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [{ effect: 'Allow', action: ['traces:ListTraces'] }],
          },
        });
      const keyRes = await authenticatedTestClient(userToken)
        .post('/api/v1/api-keys')
        .send({
          name: 'No GetTraceTree Key',
          project_id: projectId,
          policy_ids: [policyRes.body.id],
        });
      expect(keyRes.status).toBe(201);

      const res = await authenticatedTestClient(keyRes.body.key as string).get(
        `/api/v1/traces/${traceId}/tree`
      );
      expect(res.status).toBe(403);
    });
  });

  // Generations for a trace are now listed via GET /api/v1/generations?trace_id=
  // (the former GET /traces/:trace_id/generations was removed).
  describe('GET /api/v1/generations?trace_id=', () => {
    test('unauthenticated request returns 401', async () => {
      const res = await testClient.get(
        `/api/v1/generations?trace_id=${traceId}`
      );
      expect(res.status).toBe(401);
    });

    test('authenticated user can list generations for a trace', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/generations?trace_id=${traceId}`
      );
      expect(res.status).toBe(200);
      const ids = res.body.data.map((g: { id: string }) => {
        return g.id;
      });
      // traceGenerationIds are the top-level ones; childGenerationId is also in this trace
      expect(ids).toEqual(
        expect.arrayContaining([...traceGenerationIds, childGenerationId])
      );
      for (const gen of res.body.data) {
        expect(gen.trace_id).toBe(traceId);
      }
    });

    test('non-existent trace returns an empty page, not 404', async () => {
      const res = await authenticatedTestClient(userToken).get(
        '/api/v1/generations?trace_id=trc_nonexistent_000000'
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.total).toBe(0);
    });

    test('user without permission cannot list generations', async () => {
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/generations?trace_id=${traceId}`
      );
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/v1/generations?initiator_generation_id=', () => {
    test('returns child generations linked to a parent generation', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/generations?initiator_generation_id=${traceGenerationIds[0]}`
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe(childGenerationId);
      expect(res.body.data[0].initiator_generation_id).toBe(
        traceGenerationIds[0]
      );
    });

    test('non-existent initiator_generation_id returns an empty page', async () => {
      const res = await authenticatedTestClient(userToken).get(
        '/api/v1/generations?initiator_generation_id=gen_doesnotexist000'
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.total).toBe(0);
    });

    test('can combine initiator_generation_id with trace_id', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/generations?trace_id=${traceId}&initiator_generation_id=${traceGenerationIds[0]}`
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe(childGenerationId);
    });
  });

  describe('GET /api/v1/traces/:trace_id/tree?include=generations', () => {
    test('embeds generations on each trace node when include=generations', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/traces/${traceId}/tree?include=generations`
      );
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(traceId);
      expect(Array.isArray(res.body.generations)).toBe(true);
      // root trace has 2 top-level + 1 child generation seeded in beforeAll
      expect(res.body.generations.length).toBeGreaterThanOrEqual(3);
      for (const gen of res.body.generations) {
        expect(gen.trace_id).toBe(traceId);
      }
    });

    test('generations field is absent without include=generations', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/traces/${traceId}/tree`
      );
      expect(res.status).toBe(200);
      expect(res.body.generations).toBeUndefined();
    });

    test('child trace node also gets its generations', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/traces/${traceId}/tree?include=generations`
      );
      expect(res.status).toBe(200);
      const childNode = res.body.children[0];
      expect(childNode.id).toBe(childTraceId);
      expect(Array.isArray(childNode.generations)).toBe(true);
    });
  });
});
