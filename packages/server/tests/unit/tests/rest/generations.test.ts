import { updateGenerationRecord } from 'src/lib/generations';

import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * Covers issue #179 — error surfacing on generation failure:
 * - upstream provider errors are mapped to 502 AI_PROVIDER_ERROR
 * - failed generations are persisted with status 'failed' and an error payload
 * - traces record the error of failed generations
 * - GET /api/v1/generations/:generation_id exposes generation records
 */
describe('Generations', () => {
  let adminToken: string;
  let userToken: string;
  let noPermToken: string;
  let agentId: string;
  let failedGenerationId: string;
  let failedTraceId: string;

  beforeAll(async () => {
    const bootstrapRes = await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'generationsadmin', password: 'supersecret' });

    if (bootstrapRes.status === 201) {
      adminToken = await loginAs('generationsadmin', 'supersecret');
    } else {
      adminToken = await loginAs('admin', 'supersecret');
    }

    const userRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'generationsuser', password: 'generationspass' });
    userToken = await loginAs('generationsuser', 'generationspass');

    await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'generationsnoperm', password: 'generationsnopass' });
    noPermToken = await loginAs('generationsnoperm', 'generationsnopass');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Generations Test Project' });
    const projectId = projectRes.body.id;

    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: [
                'agents:CreateAgent',
                'agents:CreateAgentGeneration',
                'generations:GetGeneration',
                'generations:ListGenerations',
                'generations:UpdateGeneration',
                'traces:GetTrace',
              ],
            },
          ],
        },
      });
    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userRes.body.id}/policies`)
      .send({ policy_ids: [policyRes.body.id] });

    // Provider pointing at an unreachable endpoint so a real generation
    // attempt fails with an upstream provider (API call) error.
    const aiProvRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Unreachable Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
        base_url: 'http://127.0.0.1:9/v1',
      });

    const agentRes = await authenticatedTestClient(userToken)
      .post('/api/v1/agents')
      .send({
        ai_provider_id: aiProvRes.body.id,
        project_id: projectId,
        name: 'Generations Failing Agent',
      });
    agentId = agentRes.body.id;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('provider failure surfacing on POST /api/v1/agents/:agent_id/generate', () => {
    test('returns 502 AI_PROVIDER_ERROR with generation and trace IDs in meta', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({ messages: [{ role: 'user', content: 'hello' }] });

      expect(response.status).toBe(502);
      expect(response.body.error.code).toBe('AI_PROVIDER_ERROR');
      expect(response.body.error.message).toBeDefined();
      expect(response.body.error.meta.generation_id).toBeDefined();
      expect(response.body.error.meta.trace_id).toBeDefined();

      failedGenerationId = response.body.error.meta.generation_id;
      failedTraceId = response.body.error.meta.trace_id;
    }, 60000);

    test('persists the failed generation with status failed and an error payload', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/generations/${failedGenerationId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(failedGenerationId);
      expect(response.body.status).toBe('failed');
      expect(response.body.error).toBeDefined();
      expect(response.body.error.message).toBeDefined();
      expect(response.body.trace_id).toBe(failedTraceId);
      expect(response.body.agent_id).toBe(agentId);
      expect(response.body.completed_at).toBeDefined();
    });

    test('records the error on the trace', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/traces/${failedTraceId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.error).toBeDefined();
      expect(response.body.error.message).toBeDefined();
    });
  });

  describe('requires_action tool call arg casing on POST /generate', () => {
    afterEach(() => {
      jest.clearAllMocks();
    });

    // A client tool's `args` mirror the caller-authored `parameters` JSON
    // Schema, which is stored and returned verbatim (e.g. camelCase). The
    // requires_action payload must return those keys unchanged — the outbound
    // caseTransform must not snake_case them, or the payload diverges from the
    // schema the caller owns.
    test('preserves the authored casing of tool call args', async () => {
      mockCreateGeneration.mockResolvedValueOnce({
        id: 'gen_argcase_01',
        traceId: 'trc_argcase_01',
        status: 'requires_action',
        requiredAction: {
          type: 'submit_tool_outputs' as const,
          toolCalls: [
            {
              id: 'tc_argcase_01',
              toolName: 'createOptimization',
              args: {
                adAccountId: 'act_123',
                campaignId: 'cmp_456',
                input: 'single-word-key',
              },
            },
          ],
        },
      });

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({ messages: [{ role: 'user', content: 'optimize my ads' }] });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('requires_action');

      const toolCall = response.body.required_action.tool_calls[0];
      expect(toolCall.args.adAccountId).toBe('act_123');
      expect(toolCall.args.campaignId).toBe('cmp_456');
      expect(toolCall.args.input).toBe('single-word-key');

      // The snake_cased forms must NOT appear — the middleware must leave the
      // caller-authored keys untouched.
      expect(toolCall.args.ad_account_id).toBeUndefined();
      expect(toolCall.args.campaign_id).toBeUndefined();
    });
  });

  describe('GET /api/v1/generations', () => {
    test('returns 401 when unauthenticated', async () => {
      const response = await testClient.get('/api/v1/generations');
      expect(response.status).toBe(401);
    });

    test('returns 403 when user lacks permission', async () => {
      const response = await authenticatedTestClient(noPermToken).get(
        '/api/v1/generations'
      );
      expect(response.status).toBe(403);
    });

    test('lists generations filtered by agent_id', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/generations?agent_id=${agentId}`
      );
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.total).toBeGreaterThanOrEqual(1);
      for (const gen of response.body.data) {
        expect(gen.agent_id).toBe(agentId);
      }
    });

    test('unknown agent_id filter returns an empty page', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/generations?agent_id=agent_doesnotexist0'
      );
      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([]);
      expect(response.body.total).toBe(0);
    });

    test('accepts limit and offset query params', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/generations?agent_id=${agentId}&limit=1&offset=0`
      );
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    test('admin without project scoping lists across all projects', async () => {
      const response = await authenticatedTestClient(adminToken).get(
        `/api/v1/generations?agent_id=${agentId}`
      );
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
    });
  });

  describe('GET /api/v1/generations/:generation_id', () => {
    test('returns 401 when unauthenticated', async () => {
      const response = await testClient.get('/api/v1/generations/gen_x');
      expect(response.status).toBe(401);
    });

    test('returns 403 when user lacks permission', async () => {
      const response = await authenticatedTestClient(noPermToken).get(
        `/api/v1/generations/${failedGenerationId}`
      );
      expect(response.status).toBe(403);
    });

    test('returns 404 when generation does not exist', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/generations/gen_does_not_exist'
      );
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });

    test('does not expose internal numeric IDs', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/generations/${failedGenerationId}`
      );

      expect(response.status).toBe(200);
      expect(typeof response.body.project_id).toBe('string');
    });

    test('exposes the extraction summary but never the internal pending state', async () => {
      await updateGenerationRecord({
        publicId: failedGenerationId,
        pendingState: {
          messages: [{ role: 'user', content: 'secret internal message' }],
        },
        extraction: { candidates: 2, created: 1, updated: 0, skipped: 1 },
      });

      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/generations/${failedGenerationId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.extraction).toEqual({
        candidates: 2,
        created: 1,
        updated: 0,
        skipped: 1,
      });
      // `pendingState` has no mapper entry at all, so it cannot leak under its
      // own name, inside the caller bag, or via any serialization of the row.
      expect(response.body.pending_state).toBeUndefined();
      expect(response.body.pendingState).toBeUndefined();
      expect(JSON.stringify(response.body)).not.toContain(
        'secret internal message'
      );
    });
  });

  // Server-owned generation state (usage attribution, the served agent version,
  // the model route's record, the extraction summary, internal recovery state)
  // lives in typed columns and is exposed as top-level snake_case fields.
  // `metadata` is 100% caller-owned, so there is no reserved-key blocklist to
  // maintain and a caller cannot forge attribution by writing into the bag.
  describe('server-owned state is stored in columns, not metadata', () => {
    let attributedGenerationId: string;

    beforeAll(async () => {
      const genResponse = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({
          messages: [{ role: 'user', content: 'hello' }],
          action_id: 'act_attribution_probe',
          metadata: { ticket_id: 'OPS-4821' },
        });

      expect(genResponse.status).toBe(502);
      attributedGenerationId = genResponse.body.error.meta.generation_id;
      expect(attributedGenerationId).toBeDefined();
    }, 60000);

    test('exposes usage attribution as a top-level field, not a metadata key', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/generations/${attributedGenerationId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.action_id).toBe('act_attribution_probe');
      // The caller's own bag is untouched and holds only what the caller sent.
      expect(response.body.metadata).toEqual({ ticket_id: 'OPS-4821' });
    });

    test('accepts a caller metadata key that collides with an attribution field name', async () => {
      // Previously rejected as "reserved". Now harmless: the bag cannot reach
      // the column, so there is nothing to protect and nothing to reject.
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/generations/${attributedGenerationId}`)
        .send({
          metadata: { action_id: 'act_forged', orchestrationRunId: 'run_forged' },
        });

      expect(response.status).toBe(200);
      // The bag stored the caller's keys verbatim...
      expect(response.body.metadata.action_id).toBe('act_forged');
      expect(response.body.metadata.orchestrationRunId).toBe('run_forged');
      // ...and the real attribution is unchanged.
      expect(response.body.action_id).toBe('act_attribution_probe');
      expect(response.body.orchestration_run_id).toBeNull();
    });

    test('never exposes internal recovery state under any key', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/generations/${attributedGenerationId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.pending_state).toBeUndefined();
      expect(response.body.pendingState).toBeUndefined();
      expect(response.body.metadata.pendingState).toBeUndefined();
    });
  });

  describe('caller-supplied metadata on POST /api/v1/agents/:agent_id/generate', () => {
    test('rejects non-object metadata with 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({
          messages: [{ role: 'user', content: 'hello' }],
          metadata: 'not-an-object',
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/object/i);
    });

    test('persists caller metadata on the generation record', async () => {
      // The provider is unreachable, so the generation fails with 502 — but the
      // record is created (with metadata) before the model call is attempted.
      const genResponse = await authenticatedTestClient(userToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({
          messages: [{ role: 'user', content: 'hello' }],
          metadata: { ticket_id: 'OPS-4821', team: 'payments' },
        });

      expect(genResponse.status).toBe(502);
      const genId = genResponse.body.error.meta.generation_id;
      expect(genId).toBeDefined();

      const getResponse = await authenticatedTestClient(userToken).get(
        `/api/v1/generations/${genId}`
      );

      expect(getResponse.status).toBe(200);
      expect(getResponse.body.metadata.ticket_id).toBe('OPS-4821');
      expect(getResponse.body.metadata.team).toBe('payments');
    }, 60000);
  });

  describe('PATCH /api/v1/generations/:generation_id', () => {
    test('returns 401 when unauthenticated', async () => {
      const response = await testClient
        .patch(`/api/v1/generations/${failedGenerationId}`)
        .send({ metadata: { audit: 'x' } });
      expect(response.status).toBe(401);
    });

    test('returns 403 when user lacks permission', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .patch(`/api/v1/generations/${failedGenerationId}`)
        .send({ metadata: { audit: 'x' } });
      expect(response.status).toBe(403);
    });

    test('returns 404 when generation does not exist', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch('/api/v1/generations/gen_does_not_exist')
        .send({ metadata: { audit: 'x' } });
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });

    test('rejects metadata that is not an object with 400', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/generations/${failedGenerationId}`)
        .send({ metadata: ['not', 'an', 'object'] });
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/object/i);
    });

    // Was: "rejects reserved metadata keys with 400", in both the wire and the
    // stored camelCase spelling. Usage attribution is a column now, so neither
    // spelling can reach it and there is nothing left to reject — the guard the
    // blocklist provided is structural. `metadata` cannot forge attribution is
    // asserted in the "server-owned state" describe above.
    test('does not let a metadata write reach usage attribution', async () => {
      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/generations/${failedGenerationId}`)
        .send({
          metadata: {
            orchestration_run_id: 'run_hijack',
            orchestrationRunId: 'run_hijack',
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.orchestration_run_id).toBeNull();
    });

    test('attaches caller metadata and round-trips it on GET', async () => {
      const patchResponse = await authenticatedTestClient(userToken)
        .patch(`/api/v1/generations/${failedGenerationId}`)
        .send({
          metadata: { ticket_id: 'OPS-4821', team: 'payments' },
        });

      expect(patchResponse.status).toBe(200);
      expect(patchResponse.body.id).toBe(failedGenerationId);
      expect(patchResponse.body.metadata.ticket_id).toBe('OPS-4821');
      expect(patchResponse.body.metadata.team).toBe('payments');

      const getResponse = await authenticatedTestClient(userToken).get(
        `/api/v1/generations/${failedGenerationId}`
      );
      expect(getResponse.status).toBe(200);
      expect(getResponse.body.metadata.ticket_id).toBe('OPS-4821');
      expect(getResponse.body.metadata.team).toBe('payments');
    });

    test('merges over existing caller metadata and leaves server state untouched', async () => {
      await updateGenerationRecord({
        publicId: failedGenerationId,
        metadata: { ticket_id: 'OPS-4821' },
        extraction: { candidates: 2, created: 1, updated: 0, skipped: 1 },
        pendingState: { messages: [] },
      });

      const patchResponse = await authenticatedTestClient(userToken)
        .patch(`/api/v1/generations/${failedGenerationId}`)
        .send({ metadata: { reviewer: 'alice' } });

      expect(patchResponse.status).toBe(200);
      // Newly attached key is present.
      expect(patchResponse.body.metadata.reviewer).toBe('alice');
      // Pre-existing caller key is preserved (merge, not replace).
      expect(patchResponse.body.metadata.ticket_id).toBe('OPS-4821');
      // Server state sits in its own columns, so a metadata merge cannot touch
      // it — and the bag holds nothing but the caller's two keys.
      expect(patchResponse.body.extraction).toEqual({
        candidates: 2,
        created: 1,
        updated: 0,
        skipped: 1,
      });
      expect(patchResponse.body.metadata).toEqual({
        ticket_id: 'OPS-4821',
        reviewer: 'alice',
      });
    });
  });
});
