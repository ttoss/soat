import { db } from 'src/db';
import { createGenerationRecord } from 'src/lib/generations';
import { saveTrace } from 'src/lib/traces';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, loginAs } from '../../testClient';

/**
 * The remaining modules from the #1339 audit, each with one to four item
 * routes: ingestion rules, quotas, model routes, generations, traces, chains,
 * the audit log, usage thresholds and the session fork.
 *
 * One file rather than nine, because the property is one property — a policy
 * naming one resource reaches it and refuses its siblings — and each module
 * contributes a handful of routes rather than a suite. The modules with enough
 * surface to carry their own story keep their own file (`toolsResourceScope`,
 * `orchestrationsResourceScope`, `guardrailsResourceScope`,
 * `evaluationsResourceScope`).
 *
 * A read the caller may not perform is `404`; a write is `403`.
 */
describe('a policy scoped to one resource does not reach its siblings', () => {
  let adminToken: string;
  let projectId: string;
  let internalProjectId: number;

  const ACTIONS = [
    'ingestion-rules:GetIngestionRule',
    'ingestion-rules:UpdateIngestionRule',
    'ingestion-rules:DeleteIngestionRule',
    'quotas:GetQuota',
    'quotas:UpdateQuota',
    'quotas:DeleteQuota',
    'model-routes:GetModelRoute',
    'model-routes:UpdateModelRoute',
    'model-routes:DeleteModelRoute',
    'generations:GetGeneration',
    'generations:UpdateGeneration',
    'generations:PurgeGenerationContent',
    'traces:GetTrace',
    'traces:GetTraceTree',
    'traces:PurgeTraceContent',
    'chains:GetChain',
    'audit:GetAuditEntry',
    'usage:ManageThresholds',
    'agents:GetSession',
    'agents:CreateSession',
  ];

  /**
   * A user whose only grant names `resources`, so every refusal below is the
   * resource check rather than a missing action.
   */
  const scopedPrincipal = async (args: {
    username: string;
    resources: string[];
  }): Promise<string> => {
    const password = `${args.username}Pass1`;
    const user = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: args.username, password });
    const policy = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            { effect: 'Allow', action: ACTIONS, resource: args.resources },
          ],
        },
      });
    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${user.body.id}/policies`)
      .send({ policy_ids: [policy.body.id] });
    return loginAs(args.username, password);
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'itemscope',
      policyActions: ACTIONS,
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;
    internalProjectId = (await db.Project.findOne({
      where: { publicId: projectId },
    }))!.id as number;
  });

  describe('ingestion rules', () => {
    let scopedToken: string;
    let allowedId: string;
    let otherId: string;
    let converterToolId: string;

    const createRule = async (glob: string): Promise<string> => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/ingestion-rules')
        .send({
          project_id: projectId,
          content_type_glob: glob,
          tool_id: converterToolId,
          file_delivery: 'base64',
          chunk_strategy: 'whole',
        });
      expect(response.status).toBe(201);
      return response.body.id;
    };

    beforeAll(async () => {
      const tool = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'itemscope-converter',
          type: 'http',
          execute: { url: 'https://example.com/convert', method: 'POST' },
        });
      converterToolId = tool.body.id;

      allowedId = await createRule('image/png');
      otherId = await createRule('image/jpeg');
      scopedToken = await scopedPrincipal({
        username: 'itemscoperule',
        resources: [`srn:${projectId}:ingestionRule:${allowedId}`],
      });
    });

    test('GET reaches the rule the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/ingestion-rules/${allowedId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(allowedId);
    });

    test('GET hides a sibling rule', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/ingestion-rules/${otherId}`
      );

      expect(response.status).toBe(404);
    });

    test('PATCH refuses a sibling rule', async () => {
      const response = await authenticatedTestClient(scopedToken)
        .patch(`/api/v1/ingestion-rules/${otherId}`)
        .send({ chunk_strategy: 'paragraph' });

      expect(response.status).toBe(403);
    });

    test('DELETE refuses a sibling rule', async () => {
      const response = await authenticatedTestClient(scopedToken).delete(
        `/api/v1/ingestion-rules/${otherId}`
      );

      expect(response.status).toBe(403);
    });

    test('DELETE reaches the rule the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken).delete(
        `/api/v1/ingestion-rules/${allowedId}`
      );

      expect(response.status).toBe(204);
    });
  });

  describe('quotas', () => {
    let scopedToken: string;
    let allowedId: string;
    let otherId: string;

    const createQuota = async (metric: string): Promise<string> => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/quotas')
        .send({
          project_id: projectId,
          scope: 'project',
          metric,
          window: 'rolling_1h',
          limit: 500,
        });
      expect(response.status).toBe(201);
      return response.body.id;
    };

    beforeAll(async () => {
      allowedId = await createQuota('requests');
      otherId = await createQuota('tokens');
      scopedToken = await scopedPrincipal({
        username: 'itemscopequota',
        resources: [`srn:${projectId}:quota:${allowedId}`],
      });
    });

    test('GET reaches the quota the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/quotas/${allowedId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(allowedId);
    });

    test('GET hides a sibling quota', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/quotas/${otherId}`
      );

      expect(response.status).toBe(404);
    });

    test('PATCH refuses a sibling quota', async () => {
      const response = await authenticatedTestClient(scopedToken)
        .patch(`/api/v1/quotas/${otherId}`)
        .send({ limit: 1 });

      expect(response.status).toBe(403);
    });

    test('DELETE reaches the quota the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken).delete(
        `/api/v1/quotas/${allowedId}`
      );

      expect(response.status).toBe(204);
    });
  });

  describe('model routes', () => {
    let scopedToken: string;
    let allowedId: string;
    let otherId: string;

    const createRoute = async (name: string): Promise<string> => {
      const provider = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: `${name}-provider`,
          provider: 'ollama',
          default_model: 'llama3.2',
        });
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/model-routes')
        .send({
          project_id: projectId,
          name,
          targets: [{ ai_provider_id: provider.body.id, model: 'llama3.2' }],
        });
      expect(response.status).toBe(201);
      return response.body.id;
    };

    beforeAll(async () => {
      allowedId = await createRoute('scoped-route');
      otherId = await createRoute('other-route');
      scopedToken = await scopedPrincipal({
        username: 'itemscoperoute',
        resources: [`srn:${projectId}:model_route:${allowedId}`],
      });
    });

    test('GET reaches the route the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/model-routes/${allowedId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(allowedId);
    });

    test('GET hides a sibling route', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/model-routes/${otherId}`
      );

      expect(response.status).toBe(404);
    });

    test('DELETE refuses a sibling route', async () => {
      const response = await authenticatedTestClient(scopedToken).delete(
        `/api/v1/model-routes/${otherId}`
      );

      expect(response.status).toBe(403);
    });

    test('DELETE reaches the route the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken).delete(
        `/api/v1/model-routes/${allowedId}`
      );

      expect(response.status).toBe(204);
    });
  });

  describe('generations and traces', () => {
    let scopedToken: string;
    let allowedGenerationId: string;
    let otherGenerationId: string;
    let allowedTraceId: string;
    let otherTraceId: string;
    let agentPublicId: string;

    const seed = async (suffix: string): Promise<[string, string]> => {
      const traceId = `trc_itemscope_${suffix}`;
      const generationId = `gen_itemscope_${suffix}`;
      await saveTrace({
        traceId,
        projectId: internalProjectId,
        projectPublicId: projectId,
        agentId: agentPublicId,
        generationId,
        steps: [{ type: 'text-delta', text: 'hello' }],
      });
      await createGenerationRecord({
        publicId: generationId,
        projectId: internalProjectId,
        agentId: agentPublicId,
        traceId,
      });
      return [generationId, traceId];
    };

    beforeAll(async () => {
      const provider = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'itemscope-gen-provider',
          provider: 'ollama',
          default_model: 'llama3.2',
        });
      const agent = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          name: 'Itemscope Agent',
          ai_provider_id: provider.body.id,
        });
      agentPublicId = agent.body.id;

      [allowedGenerationId, allowedTraceId] = await seed('allowed');
      [otherGenerationId, otherTraceId] = await seed('other');

      scopedToken = await scopedPrincipal({
        username: 'itemscopegen',
        resources: [
          `srn:${projectId}:generation:${allowedGenerationId}`,
          `srn:${projectId}:trace:${allowedTraceId}`,
        ],
      });
    });

    test('GET reaches the generation the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/generations/${allowedGenerationId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(allowedGenerationId);
    });

    test('GET hides a sibling generation', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/generations/${otherGenerationId}`
      );

      expect(response.status).toBe(404);
    });

    test('PATCH refuses a sibling generation', async () => {
      const response = await authenticatedTestClient(scopedToken)
        .patch(`/api/v1/generations/${otherGenerationId}`)
        .send({ metadata: { smuggled: 'yes' } });

      expect(response.status).toBe(403);
    });

    test('PATCH reaches the generation the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken)
        .patch(`/api/v1/generations/${allowedGenerationId}`)
        .send({ metadata: { corpus: 'v3' } });

      expect(response.status).toBe(200);
    });

    // The transcript projects the generation *and* its trace, so it is
    // authorized against both — a grant naming only the generation is not
    // enough, which is what keeps `GetGeneration` from widening into trace
    // content.
    test('the transcript reaches a generation whose trace is also named', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/generations/${allowedGenerationId}/transcript`
      );

      expect(response.status).toBe(200);
    });

    test('GET reaches the trace the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/traces/${allowedTraceId}`
      );

      expect(response.status).toBe(200);
    });

    test('GET hides a sibling trace', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/traces/${otherTraceId}`
      );

      expect(response.status).toBe(404);
    });

    test('the trace tree hides a sibling trace', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/traces/${otherTraceId}/tree`
      );

      expect(response.status).toBe(404);
    });

    test('purging content refuses a sibling trace', async () => {
      const response = await authenticatedTestClient(scopedToken).delete(
        `/api/v1/traces/${otherTraceId}/content`
      );

      expect(response.status).toBe(403);
    });

    test('purging content refuses a sibling generation', async () => {
      const response = await authenticatedTestClient(scopedToken).delete(
        `/api/v1/generations/${otherGenerationId}/content`
      );

      expect(response.status).toBe(403);
    });

    test('purging content reaches the trace the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken).delete(
        `/api/v1/traces/${allowedTraceId}/content`
      );

      expect(response.status).toBe(200);
    });
  });

  describe('chains', () => {
    let scopedToken: string;
    let allowedId: string;
    let otherId: string;

    const seedChain = async (rootGenerationId: string): Promise<string> => {
      const chain = await db.GenerationChain.create({
        projectId: internalProjectId,
        agentId: null,
        rootGenerationId,
        status: 'active',
        generationCount: 1,
        lastGenerationAt: new Date(),
      });
      return chain.publicId;
    };

    beforeAll(async () => {
      allowedId = await seedChain('gen_itemscope_chain_a');
      otherId = await seedChain('gen_itemscope_chain_b');
      scopedToken = await scopedPrincipal({
        username: 'itemscopechain',
        resources: [`srn:${projectId}:chain:${allowedId}`],
      });
    });

    test('GET reaches the chain the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/chains/${allowedId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(allowedId);
    });

    test('GET hides a sibling chain', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/chains/${otherId}`
      );

      expect(response.status).toBe(404);
    });
  });

  describe('audit log', () => {
    let scopedToken: string;
    let allowedId: string;
    let otherId: string;

    const seedEntry = async (action: string): Promise<string> => {
      const entry = await db.AuditEntry.create({
        projectId: internalProjectId,
        action,
        status: 200,
      });
      return entry.publicId;
    };

    beforeAll(async () => {
      allowedId = await seedEntry('itemscope:Allowed');
      otherId = await seedEntry('itemscope:Other');
      scopedToken = await scopedPrincipal({
        username: 'itemscopeaudit',
        resources: [`srn:${projectId}:audit:${allowedId}`],
      });
    });

    test('GET reaches the entry the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/audit-log/${allowedId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(allowedId);
    });

    test('GET hides a sibling entry', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        `/api/v1/audit-log/${otherId}`
      );

      expect(response.status).toBe(404);
    });
  });

  describe('usage thresholds', () => {
    let scopedToken: string;
    let allowedId: string;
    let otherId: string;

    const createThreshold = async (threshold: number): Promise<string> => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/usage/thresholds')
        .send({
          project_id: projectId,
          metric: 'cost_usd',
          window: 'calendar_month',
          threshold,
        });
      expect(response.status).toBe(201);
      return response.body.id;
    };

    beforeAll(async () => {
      allowedId = await createThreshold(100);
      otherId = await createThreshold(200);
      scopedToken = await scopedPrincipal({
        username: 'itemscopeusage',
        resources: [`srn:${projectId}:usage:${allowedId}`],
      });
    });

    test('DELETE refuses a sibling threshold', async () => {
      const response = await authenticatedTestClient(scopedToken).delete(
        `/api/v1/usage/thresholds/${otherId}`
      );

      expect(response.status).toBe(403);
    });

    test('DELETE reaches the threshold the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken).delete(
        `/api/v1/usage/thresholds/${allowedId}`
      );

      expect(response.status).toBe(204);
    });
  });

  describe('session fork', () => {
    let scopedToken: string;
    let allowedId: string;
    let otherId: string;

    beforeAll(async () => {
      const provider = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'itemscope-fork-provider',
          provider: 'ollama',
          default_model: 'llama3.2',
        });
      const agent = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          name: 'Itemscope Fork Agent',
          ai_provider_id: provider.body.id,
        });

      const createSession = async (name: string): Promise<string> => {
        const response = await authenticatedTestClient(adminToken)
          .post('/api/v1/sessions')
          .send({ agent_id: agent.body.id, name });
        expect(response.status).toBe(201);
        return response.body.id;
      };

      allowedId = await createSession('Scoped Session');
      otherId = await createSession('Other Session');
      scopedToken = await scopedPrincipal({
        username: 'itemscopefork',
        resources: [`srn:${projectId}:session:${allowedId}`],
      });
    });

    test('refuses a sibling session', async () => {
      const response = await authenticatedTestClient(scopedToken)
        .post(`/api/v1/sessions/${otherId}/fork`)
        .send({});

      expect(response.status).toBe(403);
    });

    test('reaches the session the policy names', async () => {
      const response = await authenticatedTestClient(scopedToken)
        .post(`/api/v1/sessions/${allowedId}/fork`)
        .send({});

      expect(response.status).toBe(201);
    });
  });
});
