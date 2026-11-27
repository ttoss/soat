import { flushPlaybookExecutions } from 'src/lib/playbookCascade';

import { setupProjectWithUsers, testGrant } from '../../fixtures/bootstrap';
import {
  type ChatCompletionsStub,
  startChatCompletionsStub,
} from '../../fixtures/chatCompletionsStub';
import { createPlaybookCase } from '../../fixtures/playbookCase';
import { authenticatedTestClient } from '../../testClient';

/**
 * A playbook's `knowledge`, and an `agent` executor's over it, reach the node's
 * generation as its per-call `knowledge_config`, read under the playbook's
 * `policy_ids`.
 */
const runsOnAmount = (args: {
  executor: Record<string, unknown>;
  knowledge?: Record<string, unknown>;
}) => {
  return {
    ...(args.knowledge ? { knowledge: args.knowledge } : {}),
    nodes: [
      {
        id: 'pricing',
        title: 'Pricing',
        kind: 'execute',
        inputs: [
          {
            name: 'amount',
            schema: { type: 'number' },
            required: true,
            source: 'manual',
          },
        ],
        executor: args.executor,
      },
    ],
  };
};

describe('Playbook knowledge', () => {
  let stub: ChatCompletionsStub;
  let adminToken: string;
  let projectId: string;
  let agentId: string;
  let toolId: string;
  let handbookId: string;
  let nodeDocId: string;
  let secretId: string;
  let seq = 0;

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const create = async (path: string, body: Record<string, unknown>) => {
    const res = await asAdmin()
      .post(path)
      .send({ project_id: projectId, ...body });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const createPlaybook = (args: {
    definition: object;
    policyIds?: string[];
  }) => {
    seq += 1;
    return asAdmin()
      .post('/api/v1/playbooks')
      .send({
        project_id: projectId,
        policy_ids: args.policyIds ?? [],
        name: `knowledge-${seq}`,
        definition: args.definition,
      });
  };

  /** The document ids the node's generation retrieved. */
  const retrievedBy = async (args: {
    definition: object;
    policyIds?: string[];
  }): Promise<string[]> => {
    const playbook = await createPlaybook({
      definition: args.definition,
      policyIds: args.policyIds ?? (await testGrant({ token: adminToken })),
    });
    expect(playbook.status).toBe(201);
    const created = await createPlaybookCase({
      client: asAdmin(),
      playbookId: playbook.body.id,
      body: { subject: `client-${seq}` },
    });
    expect(created.status).toBe(201);
    const caseId = created.body.id as string;
    const current = await asAdmin().get(`/api/v1/playbook-cases/${caseId}`);
    const revision = current.body.nodes[0].inputs[0].revision;
    const res = await asAdmin()
      .post(`/api/v1/playbook-cases/${caseId}/inputs`)
      .send({
        inputs: [
          {
            node_id: 'pricing',
            name: 'amount',
            value: 1,
            expected_revision: revision,
          },
        ],
      });
    expect(res.status).toBe(200);
    await flushPlaybookExecutions();
    const executions = await asAdmin().get(
      `/api/v1/playbook-cases/${caseId}/executions`
    );
    const [execution] = executions.body.data;
    expect(execution.status).toBe('completed');
    const generation = await asAdmin().get(
      `/api/v1/generations/${execution.run_id}`
    );
    expect(generation.status).toBe(200);
    return (generation.body.retrieval ?? []).map(
      (entry: { document_id: string }) => {
        return entry.document_id;
      }
    );
  };

  beforeAll(async () => {
    stub = await startChatCompletionsStub();
    const setup = await setupProjectWithUsers({
      prefix: 'playbookknowledge',
      policyActions: [],
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;

    const providerId = await create('/api/v1/ai-providers', {
      name: 'knowledge-provider',
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: stub.baseUrl,
    });
    agentId = await create('/api/v1/agents', {
      ai_provider_id: providerId,
      name: 'knowledge-agent',
      max_steps: 1,
    });
    toolId = await create('/api/v1/tools', {
      name: 'knowledge-tool',
      type: 'http',
      description: 'A tool',
      parameters: { type: 'object', properties: {} },
      execute: { url: `${stub.baseUrl}/tool`, method: 'POST' },
    });
    handbookId = await create('/api/v1/documents', {
      content: 'Prices are set per regime.',
      path: '/handbook/pricing.md',
    });
    nodeDocId = await create('/api/v1/documents', {
      content: 'The simplified regime caps revenue.',
      path: '/node/regime.md',
    });
    secretId = await create('/api/v1/documents', {
      content: 'The margin target is confidential.',
      path: '/secret/margin.md',
    });
  });

  afterAll(async () => {
    await stub.close();
  });

  describe('POST /api/v1/playbooks', () => {
    test('stores the playbook knowledge and serves it on GET', async () => {
      const knowledge = { document_paths: ['/handbook/'], limit: 5 };
      const created = await createPlaybook({
        definition: runsOnAmount({
          knowledge,
          executor: {
            type: 'agent',
            id: agentId,
            knowledge: { document_paths: ['/node/'] },
          },
        }),
        policyIds: await testGrant({ token: adminToken }),
      });
      expect(created.status).toBe(201);

      const read = await asAdmin().get(`/api/v1/playbooks/${created.body.id}`);

      expect(read.body.definition.knowledge).toEqual(knowledge);
      expect(read.body.definition.nodes[0].executor.knowledge).toEqual({
        document_paths: ['/node/'],
      });
    });

    test('refuses knowledge on a tool executor', async () => {
      const res = await createPlaybook({
        definition: runsOnAmount({
          executor: {
            type: 'tool',
            id: toolId,
            knowledge: { document_paths: ['/node/'] },
          },
        }),
        policyIds: await testGrant({ token: adminToken }),
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('refuses a knowledge field a generation does not take', async () => {
      const res = await createPlaybook({
        definition: runsOnAmount({
          knowledge: { write_memory_store_id: 'mst_V1StGXR8Z5jdHi6B' },
          executor: { type: 'agent', id: agentId },
        }),
        policyIds: await testGrant({ token: adminToken }),
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('an agent node', () => {
    test('retrieves the documents the playbook declares', async () => {
      const retrieved = await retrievedBy({
        definition: runsOnAmount({
          knowledge: { document_paths: ['/handbook/'] },
          executor: { type: 'agent', id: agentId },
        }),
      });

      expect(retrieved).toEqual([handbookId]);
    });

    test("adds the executor's paths to the playbook's", async () => {
      const retrieved = await retrievedBy({
        definition: runsOnAmount({
          knowledge: { document_paths: ['/handbook/'] },
          executor: {
            type: 'agent',
            id: agentId,
            knowledge: { document_paths: ['/node/'] },
          },
        }),
      });

      expect(retrieved.sort()).toEqual([handbookId, nodeDocId].sort());
    });

    test("excludes a path the playbook's policies deny", async () => {
      const policyId = await create('/api/v1/policies', {
        document: {
          statement: [
            { effect: 'Allow', action: ['*'], resource: ['*'] },
            {
              effect: 'Deny',
              action: ['knowledge:SearchKnowledge'],
              resource: [`srn:${projectId}:document:/secret/*`],
            },
          ],
        },
      });

      const retrieved = await retrievedBy({
        policyIds: [policyId],
        definition: runsOnAmount({
          knowledge: { document_paths: ['/handbook/', '/secret/'] },
          executor: { type: 'agent', id: agentId },
        }),
      });

      expect(retrieved).toEqual([handbookId]);
      expect(retrieved).not.toContain(secretId);
    });

    test('retrieves nothing when nothing declares knowledge', async () => {
      const retrieved = await retrievedBy({
        definition: runsOnAmount({
          executor: { type: 'agent', id: agentId },
        }),
      });

      expect(retrieved).toEqual([]);
    });
  });
});
