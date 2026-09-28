import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * What `knowledge_config` retrieval served a generation, read back off the
 * generation record.
 *
 * The generations are real: the agent's provider points at a local
 * OpenAI-compatible stub, so retrieval, injection and the record write all run.
 */
describe('Generation retrieval record', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let providerId: string;
  let stubServer: Server;

  const completion = {
    id: 'chatcmpl-stub',
    object: 'chat.completion',
    created: 0,
    model: 'stub-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'Done.' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  };

  const startStubServer = async (): Promise<string> => {
    stubServer = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(completion));
      });
    });
    await new Promise<void>((resolve) => {
      stubServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = stubServer.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  const asUser = () => {
    return authenticatedTestClient(userToken);
  };

  const createAgent = async (args: {
    name: string;
    knowledgeConfig?: Record<string, unknown>;
  }): Promise<string> => {
    const res = await asUser()
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: providerId,
        name: args.name,
        ...(args.knowledgeConfig
          ? { knowledge_config: args.knowledgeConfig }
          : {}),
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const createDocument = async (args: {
    content: string;
    path: string;
  }): Promise<string> => {
    const res = await asUser().post('/api/v1/documents').send({
      project_id: projectId,
      content: args.content,
      path: args.path,
    });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  /** Runs one turn and returns the stored generation record. */
  const generate = async (agentId: string) => {
    const res = await asUser()
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'What is the policy?' }] });
    expect(res.status).toBe(200);

    const generation = await asUser().get(`/api/v1/generations/${res.body.id}`);
    expect(generation.status).toBe(200);
    return generation.body;
  };

  const searchChunkIds = async (documentId: string): Promise<string[]> => {
    const res = await asUser()
      .post('/api/v1/knowledge/search')
      .send({ project_id: projectId, document_ids: [documentId] });
    expect(res.status).toBe(200);
    return res.body.results.map((result: { chunk_id: string }) => {
      return result.chunk_id;
    });
  };

  beforeAll(async () => {
    const stubBaseUrl = await startStubServer();

    const setup = await setupProjectWithUsers({
      prefix: 'genretrieval',
      policyActions: [
        'agents:CreateAgent',
        'agents:CreateAgentGeneration',
        'documents:CreateDocument',
        'documents:UpdateDocument',
        'generations:GetGeneration',
        'generations:ListGenerations',
        'generations:PurgeGenerationContent',
        'knowledge:SearchKnowledge',
      ],
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;

    const providerRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Retrieval Provider',
        provider: 'ollama',
        default_model: 'stub-model',
        base_url: stubBaseUrl,
      });
    expect(providerRes.status).toBe(201);
    providerId = providerRes.body.id;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      stubServer.close((err) => {
        return err ? reject(err) : resolve();
      });
    });
  });

  describe('GET /api/v1/generations/:generation_id', () => {
    test('records the document, version and chunk the turn was served', async () => {
      const documentId = await createDocument({
        content: 'Refunds are issued within 14 days.',
        path: '/playbooks/refunds.md',
      });
      const agentId = await createAgent({
        name: 'Retrieval Document Agent',
        knowledgeConfig: { document_ids: [documentId] },
      });

      const generation = await generate(agentId);

      expect(generation.retrieval).toEqual([
        {
          source_type: 'document',
          document_id: documentId,
          document_version: 1,
          chunk_id: (await searchChunkIds(documentId))[0],
          page: null,
          similarity_score: expect.any(Number),
        },
      ]);
      // A record of what was read, never a copy of it.
      expect(generation.retrieval[0].content).toBeUndefined();
    });

    test('a document edited between two turns leaves each turn citing the version it read', async () => {
      const documentId = await createDocument({
        content: 'Escalate after 2 failed attempts.',
        path: '/playbooks/escalation.md',
      });
      const agentId = await createAgent({
        name: 'Retrieval Versioned Agent',
        knowledgeConfig: { document_ids: [documentId] },
      });

      const before = await generate(agentId);
      const edit = await asUser()
        .patch(`/api/v1/documents/${documentId}`)
        .send({ content: 'Escalate after 3 failed attempts.' });
      expect(edit.status).toBe(200);
      const after = await generate(agentId);

      expect(before.retrieval[0].document_version).toBe(1);
      expect(after.retrieval[0].document_version).toBe(2);
      const refetched = await asUser().get(`/api/v1/generations/${before.id}`);
      expect(refetched.body.retrieval[0].document_version).toBe(1);
    });

    test('records the memory store and memory a turn was served', async () => {
      const storeRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/memory-stores')
        .send({ project_id: projectId, name: 'Retrieval Memory Store' });
      expect(storeRes.status).toBe(201);
      const memoryRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/memories')
        .send({
          memory_store_id: storeRes.body.id,
          content: 'The customer prefers email.',
        });
      expect(memoryRes.status).toBe(201);
      const agentId = await createAgent({
        name: 'Retrieval Memory Agent',
        knowledgeConfig: { memory_store_ids: [storeRes.body.id] },
      });

      const generation = await generate(agentId);

      expect(generation.retrieval).toEqual([
        {
          source_type: 'memory',
          memory_store_id: storeRes.body.id,
          memory_id: memoryRes.body.id,
          similarity_score: expect.any(Number),
        },
      ]);
    });

    test('is null when the agent has no knowledge_config', async () => {
      const agentId = await createAgent({ name: 'Retrieval No Config Agent' });

      const generation = await generate(agentId);

      expect(generation.retrieval).toBeNull();
    });

    test('is empty, not null, when retrieval ran and matched nothing', async () => {
      const agentId = await createAgent({
        name: 'Retrieval Empty Agent',
        knowledgeConfig: { tags: { corpus: 'no-such-corpus' } },
      });

      const generation = await generate(agentId);

      // Null would say no retrieval ran; empty says it ran and injected nothing.
      expect(generation.retrieval).toEqual([]);
    });

    test('survives a content purge', async () => {
      const documentId = await createDocument({
        content: 'Warranty covers 12 months.',
        path: '/playbooks/warranty.md',
      });
      const agentId = await createAgent({
        name: 'Retrieval Purge Agent',
        knowledgeConfig: { document_ids: [documentId] },
      });
      const generation = await generate(agentId);

      const purge = await asUser().delete(
        `/api/v1/generations/${generation.id}/content`
      );
      expect(purge.status).toBe(200);

      const res = await asUser().get(`/api/v1/generations/${generation.id}`);
      expect(res.body.content_redacted_at).not.toBeNull();
      expect(res.body.retrieval).toEqual(generation.retrieval);
    });
  });

  describe('GET /api/v1/generations', () => {
    test('carries the retrieval record on each listed generation', async () => {
      const documentId = await createDocument({
        content: 'Shipping is free above 50 dollars.',
        path: '/playbooks/shipping.md',
      });
      const agentId = await createAgent({
        name: 'Retrieval Listed Agent',
        knowledgeConfig: { document_ids: [documentId] },
      });
      const generation = await generate(agentId);

      const res = await asUser().get(`/api/v1/generations?agent_id=${agentId}`);

      expect(res.status).toBe(200);
      expect(res.body.data[0].id).toBe(generation.id);
      expect(res.body.data[0].retrieval).toEqual(generation.retrieval);
    });
  });
});
