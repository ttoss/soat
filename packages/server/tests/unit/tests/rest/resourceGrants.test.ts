import {
  createAllowAllPolicy,
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * Evals, deciders, ingestion and memory rules and playbooks run their work
 * under the `policy_ids` they carry: a create names at least one, and only
 * policies its writer holds.
 */
describe('Resource grants', () => {
  let adminToken: string;
  let writerToken: string;
  let projectId: string;
  let agentId: string;
  let toolId: string;
  let datasetId: string;
  let memoryStoreId: string;
  let widerPolicyId: string;
  let seq = 0;

  const admin = () => {
    return authenticatedTestClient(adminToken);
  };

  const unique = (base: string) => {
    seq += 1;
    return `${base}-${seq}`;
  };

  const createdId = async (
    request: Promise<{ status: number; body: { id: string } }>
  ) => {
    const res = await request;
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const CARRIERS: Array<[string, () => Record<string, unknown>]> = [
    [
      '/api/v1/evals',
      () => {
        return {
          project_id: projectId,
          name: unique('rg-eval'),
          agent_id: agentId,
          dataset_id: datasetId,
          scorers: [{ type: 'exact_match' }],
        };
      },
    ],
    [
      '/api/v1/deciders',
      () => {
        return {
          project_id: projectId,
          name: unique('rg-decider'),
          agent_id: agentId,
          questions: [
            { type: 'predicate', name: 'urgent', instructions: 'Urgent?' },
          ],
        };
      },
    ],
    [
      '/api/v1/ingestion-rules',
      () => {
        return {
          project_id: projectId,
          content_type_glob: `application/x-rg-${unique('type')}`,
          tool_id: toolId,
        };
      },
    ],
    [
      '/api/v1/memory-rules',
      () => {
        return { memory_store_id: memoryStoreId, on: 'generations.completed' };
      },
    ],
    [
      '/api/v1/playbooks',
      () => {
        return {
          project_id: projectId,
          name: unique('rg-playbook'),
          definition: {
            nodes: [{ id: 'only', title: 'Only', kind: 'collect', inputs: [] }],
          },
        };
      },
    ],
  ];

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'resourcegrants',
      policyActions: [],
      createOtherProject: false,
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;

    const providerId = await createdId(
      admin().post('/api/v1/ai-providers').send({
        project_id: projectId,
        name: 'rg-provider',
        provider: 'ollama',
        default_model: 'stub-model',
      })
    );
    agentId = await createdId(
      admin()
        .post('/api/v1/agents')
        .send({ project_id: projectId, ai_provider_id: providerId, name: 'rg' })
    );
    toolId = await createdId(
      admin()
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'rg-tool',
          type: 'http',
          execute: { url: 'https://example.com/run', method: 'POST' },
        })
    );
    datasetId = await createdId(
      admin()
        .post('/api/v1/datasets')
        .send({ project_id: projectId, name: 'rg-dataset' })
    );
    memoryStoreId = await createdId(
      admin()
        .post('/api/v1/memory-stores')
        .send({ project_id: projectId, name: 'rg-store' })
    );
    widerPolicyId = await createAllowAllPolicy({ adminToken });
    writerToken = await createScopedPrincipal({
      adminToken,
      projectId,
      username: 'rgwriter',
      actions: [
        'evaluations:CreateEval',
        'deciders:CreateDecider',
        'ingestion-rules:CreateIngestionRule',
        'memories:CreateMemoryRule',
        'playbooks:CreatePlaybook',
        'agents:CreateAgentGeneration',
        'tools:CallTool',
      ],
    });
  });

  describe.each(CARRIERS)('POST %s', (path, body) => {
    test('refuses a create without policy_ids', async () => {
      const res = await admin().post(path).send(body());

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('refuses an empty policy_ids', async () => {
      const res = await admin()
        .post(path)
        .send({ ...body(), policy_ids: [] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('refuses a policy the writer does not hold', async () => {
      const res = await authenticatedTestClient(writerToken)
        .post(path)
        .send({ ...body(), policy_ids: [widerPolicyId] });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('POLICY_GRANT_NOT_HELD');
    });

    test('creates one carrying a policy the admin holds', async () => {
      const res = await admin()
        .post(path)
        .send({ ...body(), policy_ids: [widerPolicyId] });

      expect(res.status).toBe(201);
      expect(res.body.policy_ids).toEqual([widerPolicyId]);
    });
  });
});
