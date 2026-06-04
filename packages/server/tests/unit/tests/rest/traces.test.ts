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
                'traces:GetTraceGenerations',
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
  });

  describe('GET /api/v1/traces/:trace_id/generations', () => {
    test('unauthenticated request returns 401', async () => {
      const res = await testClient.get(`/api/v1/traces/${traceId}/generations`);
      expect(res.status).toBe(401);
    });

    test('authenticated user can get generation IDs for a trace', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/traces/${traceId}/generations`
      );
      expect(res.status).toBe(200);
      expect(res.body.trace_id).toBe(traceId);
      expect(res.body.generation_ids).toEqual(traceGenerationIds);
    });

    test('returns 404 for non-existent trace', async () => {
      const res = await authenticatedTestClient(userToken).get(
        '/api/v1/traces/trc_nonexistent_000000/generations'
      );
      expect(res.status).toBe(404);
    });

    test('user without permission cannot get generation IDs', async () => {
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/traces/${traceId}/generations`
      );
      expect(res.status).toBe(403);
    });
  });
});
