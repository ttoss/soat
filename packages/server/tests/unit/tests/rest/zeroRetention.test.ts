import { db } from 'src/db';
import { systemPath } from 'src/lib/filePaths';

import {
  type ChatCompletionsStub,
  providerFailure,
  startChatCompletionsStub,
  textCompletion,
} from '../../fixtures/chatCompletionsStub';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * Zero-retention (`trace_content_mode: none`) suppresses content at the write
 * chokepoints a real generation passes through — the steps object, the
 * generation's content columns, a trace's error payload — while the skeleton
 * (rows, counters, status) is still written, so the run stays auditable and
 * attributable. The effective mode is the stricter of the project's and the
 * agent's.
 */
describe('POST /api/v1/agents/:agent_id/generate under trace_content_mode', () => {
  let stub: ChatCompletionsStub;
  let adminToken: string;
  let storingProjectId: string;
  let storingProviderId: string;
  let storingAgentId: string;
  let tightenedAgentId: string;
  let inheritedAgentId: string;

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const createProvider = async (projectId: string): Promise<string> => {
    const res = await asAdmin()
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: `ZR Provider ${projectId}`,
        provider: 'ollama',
        default_model: 'stub-model',
        base_url: stub.baseUrl,
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const createAgent = async (args: {
    projectId: string;
    aiProviderId: string;
    name: string;
    traceContentMode?: string;
  }): Promise<string> => {
    const res = await asAdmin()
      .post('/api/v1/agents')
      .send({
        project_id: args.projectId,
        ai_provider_id: args.aiProviderId,
        name: args.name,
        ...(args.traceContentMode
          ? { trace_content_mode: args.traceContentMode }
          : {}),
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const generate = (agentId: string) => {
    return asAdmin()
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({
        messages: [{ role: 'user', content: 'confidential case content' }],
        metadata: { ticket_id: 'CASE-42' },
      });
  };

  const traceOf = (traceId: string) => {
    return asAdmin().get(`/api/v1/traces/${traceId}`);
  };

  const generationOf = (generationId: string) => {
    return asAdmin().get(`/api/v1/generations/${generationId}`);
  };

  beforeAll(async () => {
    stub = await startChatCompletionsStub();

    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'zradmin', password: 'supersecret' });
    adminToken = await loginAs('zradmin', 'supersecret');

    const storingProject = await asAdmin()
      .post('/api/v1/projects')
      .send({ name: 'ZR Storing Project' });
    storingProjectId = storingProject.body.id;

    const zeroProject = await asAdmin()
      .post('/api/v1/projects')
      .send({ name: 'ZR Zero Project' });
    const patched = await asAdmin()
      .patch(`/api/v1/projects/${zeroProject.body.id}`)
      .send({ trace_content_mode: 'none' });
    expect(patched.status).toBe(200);

    storingProviderId = await createProvider(storingProjectId);
    storingAgentId = await createAgent({
      projectId: storingProjectId,
      aiProviderId: storingProviderId,
      name: 'ZR Storing Agent',
    });
    tightenedAgentId = await createAgent({
      projectId: storingProjectId,
      aiProviderId: storingProviderId,
      name: 'ZR Tightened Agent',
      traceContentMode: 'none',
    });
    inheritedAgentId = await createAgent({
      projectId: zeroProject.body.id,
      aiProviderId: await createProvider(zeroProject.body.id),
      name: 'ZR Inherited Agent',
    });
  });

  afterEach(() => {
    stub.reply(textCompletion('ok'));
  });

  afterAll(async () => {
    await stub.close();
  });

  describe('a completed generation', () => {
    test('a storing agent writes the steps object and its metadata', async () => {
      const res = await generate(storingAgentId);
      expect(res.status).toBe(200);

      const trace = await traceOf(res.body.trace_id);
      expect(trace.status).toBe(200);
      expect(trace.body.file_id).not.toBeNull();
      expect(trace.body.content_redacted_at).toBeNull();
      expect(trace.body.step_count).toBe(1);

      const generation = await generationOf(res.body.id);
      expect(generation.body.metadata).toEqual({ ticket_id: 'CASE-42' });
      expect(generation.body.content_redacted_at).toBeNull();
    });

    test('an agent tightened to none never creates the steps file', async () => {
      const res = await generate(tightenedAgentId);
      expect(res.status).toBe(200);

      const trace = await traceOf(res.body.trace_id);
      expect(trace.body.file_id).toBeNull();
      // A counter, not content: step_count is part of the skeleton.
      expect(trace.body.step_count).toBe(1);

      // Not merely unlinked from the row: no file was ever written.
      const files = await db.File.findAll({
        where: {
          path: systemPath({
            module: 'traces',
            leaf: `${res.body.trace_id}.json`,
          }),
        },
      });
      expect(files).toHaveLength(0);
    });

    test('an agent under a zero-retention project inherits it, stamped as never-stored', async () => {
      const res = await generate(inheritedAgentId);
      expect(res.status).toBe(200);

      const trace = await traceOf(res.body.trace_id);
      expect(trace.body.file_id).toBeNull();
      expect(trace.body.agent_id).toBe(inheritedAgentId);
      expect(trace.body.content_redacted_at).not.toBeNull();
      expect(trace.body.content_redacted_by_principal_type).toBe('system');
      expect(trace.body.content_redacted_by_principal_id).toBe(
        'zero_retention'
      );

      const generation = await generationOf(res.body.id);
      expect(generation.body.metadata).toBeNull();
      expect(generation.body.content_redacted_at).not.toBeNull();
      expect(generation.body.content_redacted_by_principal_id).toBe(
        'zero_retention'
      );
    });
  });

  describe('a failed generation', () => {
    test('a storing agent records the error payload on the trace', async () => {
      stub.reply(providerFailure(400));

      const res = await generate(storingAgentId);
      expect(res.status).toBe(502);

      const trace = await traceOf(res.body.error.meta.trace_id);
      expect(trace.body.error.code).toBe('AI_PROVIDER_ERROR');
    });

    // An error payload can carry a tool's request and response bodies, which
    // is why a purge clears it: the never-write mode refuses it too.
    test('a zero-retention agent records the failure but no error payload', async () => {
      stub.reply(providerFailure(400));

      const res = await generate(inheritedAgentId);
      expect(res.status).toBe(502);
      const { trace_id: traceId, generation_id: generationId } =
        res.body.error.meta;

      const trace = await traceOf(traceId);
      expect(trace.body.error).toBeNull();
      expect(trace.body.content_redacted_at).not.toBeNull();

      const generation = await generationOf(generationId);
      expect(generation.body.status).toBe('failed');
      expect(generation.body.error).toBeNull();
      expect(generation.body.content_redacted_by_principal_id).toBe(
        'zero_retention'
      );
    });
  });

  test('flipping a project to none takes effect on the very next generation', async () => {
    const flipProject = await asAdmin()
      .post('/api/v1/projects')
      .send({ name: 'ZR Flip Project' });
    const agentId = await createAgent({
      projectId: flipProject.body.id,
      aiProviderId: await createProvider(flipProject.body.id),
      name: 'ZR Flip Agent',
    });

    const before = await generate(agentId);
    expect((await traceOf(before.body.trace_id)).body.file_id).not.toBeNull();

    await asAdmin()
      .patch(`/api/v1/projects/${flipProject.body.id}`)
      .send({ trace_content_mode: 'none' });

    // The update invalidates the mode cache, so no TTL has to pass first.
    const after = await generate(agentId);
    expect((await traceOf(after.body.trace_id)).body.file_id).toBeNull();
  });
});
