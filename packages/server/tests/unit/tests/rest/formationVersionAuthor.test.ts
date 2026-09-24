import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A formation writes config versions on its deployer's behalf, so each version
 * it archives names the deployer as its author — the same answer a direct
 * REST write gives (`versionedWriteContract.test.ts`).
 */
describe('Formation version author', () => {
  let userToken: string;
  let userId: string;
  let projectId: string;
  let aiProviderId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'fmauthor',
      policyActions: [
        'formations:*',
        'documents:*',
        'guardrails:*',
        'workflows:*',
        'orchestrations:*',
        'agents:*',
        'ai-providers:GetAiProvider',
      ],
    });
    userToken = setup.userToken;
    userId = setup.userId;
    projectId = setup.projectId;

    const provider = await authenticatedTestClient(setup.adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Author Provider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    expect(provider.status).toBe(201);
    aiProviderId = provider.body.id;
  }, 60_000);

  const client = () => {
    return authenticatedTestClient(userToken);
  };

  const template = (revision: 1 | 2) => {
    return {
      resources: {
        Doc: {
          type: 'document',
          properties: { content: `Revision ${revision}.` },
        },
        Guard: {
          type: 'guardrail',
          properties: {
            name: 'author-guardrail',
            class: revision === 1 ? 'C' : 'B',
          },
        },
        Flow: {
          type: 'workflow',
          properties: {
            name: 'author-workflow',
            states: [
              { name: 'triage', initial: true },
              { name: 'done', terminal: true },
            ],
            transitions: [{ name: 'finish', from: ['triage'], to: 'done' }],
            ...(revision === 2 ? { payload_schema: { type: 'object' } } : {}),
          },
        },
        Orch: {
          type: 'orchestration',
          properties: {
            name: 'author-orchestration',
            nodes: [{ id: 'a', type: 'transform', expression: `v${revision}` }],
            edges: [],
          },
        },
        Bot: {
          type: 'agent',
          properties: {
            ai_provider_id: aiProviderId,
            name: 'author-agent',
            instructions: `Revision ${revision}.`,
          },
        },
      },
    };
  };

  const VERSIONS_PATH: Record<string, string> = {
    Doc: '/api/v1/documents',
    Guard: '/api/v1/guardrails',
    Flow: '/api/v1/workflows',
    Orch: '/api/v1/orchestrations',
    Bot: '/api/v1/agents',
  };

  const authorsOf = async (
    resources: { logical_id: string; physical_resource_id: string }[]
  ) => {
    const authors: Record<string, (string | null)[]> = {};
    for (const resource of resources) {
      const res = await client().get(
        `${VERSIONS_PATH[resource.logical_id]}/${resource.physical_resource_id}/versions`
      );
      expect(res.status).toBe(200);
      authors[resource.logical_id] = (
        res.body.data as { created_by: string | null }[]
      ).map((version) => {
        return version.created_by;
      });
    }
    return authors;
  };

  test('create and update archive versions authored by the deployer', async () => {
    const created = await client()
      .post('/api/v1/formations')
      .send({
        project_id: projectId,
        name: 'author-formation',
        template: template(1),
      });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('active');

    const updated = await client()
      .put(`/api/v1/formations/${created.body.id}`)
      .send({ template: template(2) });
    expect(updated.status).toBe(200);
    expect(updated.body.status).toBe('active');

    expect(await authorsOf(updated.body.resources)).toEqual({
      Doc: [userId, userId],
      Guard: [userId, userId],
      Flow: [userId, userId],
      Orch: [userId, userId],
      Bot: [userId, userId],
    });
  });
});
