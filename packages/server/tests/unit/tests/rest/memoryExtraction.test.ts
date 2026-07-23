import { db } from 'src/db';
import * as extractionCompletionModule from 'src/lib/memoryExtractionCompletion';

import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

// Shared spy created once at module load (same pattern as mockCreateGeneration):
// afterEach uses clearAllMocks, never restoreAllMocks.
const mockRunExtractionCompletion = jest.spyOn(
  extractionCompletionModule,
  'runExtractionCompletion'
);

const sleep = (ms: number) => {
  return new Promise((resolve) => {
    return setTimeout(resolve, ms);
  });
};

describe('Memory Extraction', () => {
  let adminToken: string;
  let projectId: string;
  let aiProviderId: string;

  const createMemory = async (name: string): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/memories')
      .send({ project_id: projectId, name });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const createAgent = async (args: {
    name: string;
    knowledgeConfig?: Record<string, unknown>;
  }): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: aiProviderId,
        name: args.name,
        knowledge_config: args.knowledgeConfig,
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const createConversationWithMessage = async (
    message: string
  ): Promise<string> => {
    const convRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/conversations')
      .send({ project_id: projectId });
    expect(convRes.status).toBe(201);

    const msgRes = await authenticatedTestClient(adminToken)
      .post(`/api/v1/conversations/${convRes.body.id}/messages`)
      .send({ role: 'user', message });
    expect(msgRes.status).toBe(201);

    return convRes.body.id;
  };

  const listEntries = async (memoryId: string) => {
    const res = await authenticatedTestClient(adminToken).get(
      `/api/v1/memory-entries?memory_id=${memoryId}`
    );
    expect(res.status).toBe(200);
    return res.body.data as Array<{
      id: string;
      content: string;
      source_type: string;
    }>;
  };

  const waitForEntries = async (
    memoryId: string,
    minCount: number,
    timeoutMs = 8000
  ) => {
    const startedAt = Date.now();
    let entries = await listEntries(memoryId);
    while (entries.length < minCount && Date.now() - startedAt < timeoutMs) {
      await sleep(100);
      entries = await listEntries(memoryId);
    }
    return entries;
  };

  // `writeCandidates` processes every extracted candidate sequentially in one
  // async chain, and `recordExtractionSummary` (writing generation.metadata.
  // extraction) only runs once that whole chain finishes. Polling for it is a
  // deterministic settle signal for "all candidates — including skipped
  // duplicates — have been processed", replacing a fixed settling sleep.
  const waitForExtractionSummary = async (
    generationId: string,
    timeoutMs = 8000
  ) => {
    const fetchSummary = async () => {
      const res = await authenticatedTestClient(adminToken).get(
        `/api/v1/generations/${generationId}`
      );
      return res.body?.metadata?.extraction;
    };

    const startedAt = Date.now();
    let summary = await fetchSummary();
    while (summary === undefined && Date.now() - startedAt < timeoutMs) {
      await sleep(50);
      summary = await fetchSummary();
    }
    return summary;
  };

  // There is no positive completion signal for "extraction never ran" (no
  // downstream write or summary is ever produced), so absence can only be
  // confirmed by polling within a bounded window instead of an unconditional
  // sleep — this still exits early if a call unexpectedly appears.
  const waitForNoExtractionAttempt = async (maxWaitMs = 500) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < maxWaitMs) {
      if (mockRunExtractionCompletion.mock.calls.length > 0) break;
      await sleep(25);
    }
  };

  const completedGeneration = (id: string, content: string) => {
    return {
      id,
      traceId: `trc_${id}`,
      status: 'completed' as const,
      output: {
        model: 'test-model',
        content,
        finishReason: 'stop',
      },
    };
  };

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'extractionadmin', password: 'supersecret' });

    adminToken = await loginAs('extractionadmin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Extraction Test Project' });
    projectId = projectRes.body.id;

    const aiProvRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'ExtractionProvider',
        provider: 'ollama',
        default_model: 'llama3.2',
      });
    aiProviderId = aiProvRes.body.id;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('knowledge_config.extraction contract', () => {
    test('agent create round-trips extraction flag in knowledge_config', async () => {
      const memoryId = await createMemory('Contract Memory');
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: 'ContractAgent',
          knowledge_config: {
            write_memory_id: memoryId,
            extraction: true,
          },
        });

      expect(res.status).toBe(201);
      expect(res.body.knowledge_config.extraction).toBe(true);
      expect(res.body.knowledge_config.write_memory_id).toBe(memoryId);
    });
  });

  describe('conversation generation trigger', () => {
    test('extracts facts into the write memory after a completed generation', async () => {
      const memoryId = await createMemory('Conv Extraction Memory');
      const agentId = await createAgent({
        name: 'ConvExtractionAgent',
        knowledgeConfig: { write_memory_id: memoryId, extraction: true },
      });
      const convId = await createConversationWithMessage(
        'I prefer to be contacted by email.'
      );

      mockCreateGeneration.mockResolvedValueOnce(
        completedGeneration('gen_ext_1', 'Noted, I will use email.')
      );
      mockRunExtractionCompletion.mockResolvedValueOnce(
        '["User prefers to be contacted by email"]'
      );

      const res = await authenticatedTestClient(adminToken)
        .post(`/api/v1/conversations/${convId}/generate`)
        .send({ agent_id: agentId });
      expect(res.status).toBe(200);

      const entries = await waitForEntries(memoryId, 1);
      expect(entries).toHaveLength(1);
      expect(entries[0].content).toBe('User prefers to be contacted by email');
      expect(entries[0].source_type).toBe('extraction');

      // The extraction prompt must include both sides of the turn.
      expect(mockRunExtractionCompletion).toHaveBeenCalledTimes(1);
      const callArgs = mockRunExtractionCompletion.mock.calls[0][0];
      expect(callArgs.agentId).toBe(agentId);
      expect(callArgs.prompt).toContain('I prefer to be contacted by email.');
      expect(callArgs.prompt).toContain('Noted, I will use email.');
    });

    test('deduplicates extracted facts through the standard write algorithm', async () => {
      const memoryId = await createMemory('Dedup Extraction Memory');
      const agentId = await createAgent({
        name: 'DedupExtractionAgent',
        knowledgeConfig: { write_memory_id: memoryId, extraction: true },
      });
      const convId = await createConversationWithMessage('My timezone is EST.');

      mockCreateGeneration.mockResolvedValueOnce(
        completedGeneration('gen_ext_2', 'Got it.')
      );
      // Two identical candidates: the second must be skipped by dedup
      // (test embeddings are constant, so identical content scores 1.0).
      mockRunExtractionCompletion.mockResolvedValueOnce(
        '["User timezone is EST", "User timezone is EST"]'
      );

      const res = await authenticatedTestClient(adminToken)
        .post(`/api/v1/conversations/${convId}/generate`)
        .send({ agent_id: agentId });
      expect(res.status).toBe(200);

      // Wait for the whole candidate batch (including the skipped duplicate)
      // to finish processing before asserting.
      await waitForExtractionSummary(res.body.generation_id);
      const settled = await listEntries(memoryId);
      expect(settled).toHaveLength(1);
      expect(settled[0].content).toBe('User timezone is EST');
    });

    test('does not run extraction when the extraction flag is not set', async () => {
      const memoryId = await createMemory('No Flag Memory');
      const agentId = await createAgent({
        name: 'NoFlagAgent',
        knowledgeConfig: { write_memory_id: memoryId },
      });
      const convId = await createConversationWithMessage('Hello there.');

      mockCreateGeneration.mockResolvedValueOnce(
        completedGeneration('gen_ext_3', 'Hi!')
      );

      const res = await authenticatedTestClient(adminToken)
        .post(`/api/v1/conversations/${convId}/generate`)
        .send({ agent_id: agentId });
      expect(res.status).toBe(200);

      await waitForNoExtractionAttempt();
      expect(mockRunExtractionCompletion).not.toHaveBeenCalled();
      expect(await listEntries(memoryId)).toHaveLength(0);
    });

    test('does not run extraction when write_memory_id is missing', async () => {
      const memoryId = await createMemory('No Target Memory');
      const agentId = await createAgent({
        name: 'NoTargetAgent',
        knowledgeConfig: { memory_ids: [memoryId], extraction: true },
      });
      const convId = await createConversationWithMessage('Hello again.');

      mockCreateGeneration.mockResolvedValueOnce(
        completedGeneration('gen_ext_4', 'Hi!')
      );

      const res = await authenticatedTestClient(adminToken)
        .post(`/api/v1/conversations/${convId}/generate`)
        .send({ agent_id: agentId });
      expect(res.status).toBe(200);

      await waitForNoExtractionAttempt();
      expect(mockRunExtractionCompletion).not.toHaveBeenCalled();
    });

    test('ignores malformed extraction output without failing the turn', async () => {
      const memoryId = await createMemory('Malformed Memory');
      const agentId = await createAgent({
        name: 'MalformedAgent',
        knowledgeConfig: { write_memory_id: memoryId, extraction: true },
      });
      const convId = await createConversationWithMessage('Some message.');

      mockCreateGeneration.mockResolvedValueOnce(
        completedGeneration('gen_ext_5', 'Some reply.')
      );
      mockRunExtractionCompletion.mockResolvedValueOnce(
        'I could not find any facts, sorry!'
      );

      const res = await authenticatedTestClient(adminToken)
        .post(`/api/v1/conversations/${convId}/generate`)
        .send({ agent_id: agentId });
      expect(res.status).toBe(200);

      // Extraction still runs (and produces a zero-candidate summary) even
      // though parsing yields nothing — wait for that summary to settle.
      await waitForExtractionSummary(res.body.generation_id);
      expect(await listEntries(memoryId)).toHaveLength(0);
    });
  });

  describe('extraction object form (overrides)', () => {
    test('passes provider, model, and prompt overrides to the completion call', async () => {
      const memoryId = await createMemory('Override Memory');

      const otherProvRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'ExtractionOverrideProvider',
          provider: 'ollama',
          default_model: 'cheap-model',
        });
      const otherProviderId = otherProvRes.body.id as string;

      const agentId = await createAgent({
        name: 'OverrideExtractionAgent',
        knowledgeConfig: {
          write_memory_id: memoryId,
          extraction: {
            ai_provider_id: otherProviderId,
            model: 'cheap-model-2',
            prompt: 'Extract only food preferences.',
          },
        },
      });
      const convId = await createConversationWithMessage('I love sushi.');

      mockCreateGeneration.mockResolvedValueOnce(
        completedGeneration('gen_ext_7', 'Sushi noted.')
      );
      mockRunExtractionCompletion.mockResolvedValueOnce('["User loves sushi"]');

      const res = await authenticatedTestClient(adminToken)
        .post(`/api/v1/conversations/${convId}/generate`)
        .send({ agent_id: agentId });
      expect(res.status).toBe(200);

      const entries = await waitForEntries(memoryId, 1);
      expect(entries).toHaveLength(1);

      expect(mockRunExtractionCompletion).toHaveBeenCalledTimes(1);
      const callArgs = mockRunExtractionCompletion.mock.calls[0][0];
      expect(callArgs.aiProviderId).toBe(otherProviderId);
      expect(callArgs.model).toBe('cheap-model-2');
      // The custom prompt replaces the default task instructions...
      expect(callArgs.prompt).toContain('Extract only food preferences.');
      expect(callArgs.prompt).not.toContain('discrete, atomic facts');
      // ...but the JSON response contract and the transcript are kept.
      expect(callArgs.prompt).toContain('JSON array');
      expect(callArgs.prompt).toContain('I love sushi.');
    });

    test('extraction object without overrides uses agent defaults', async () => {
      const memoryId = await createMemory('Object Defaults Memory');
      const agentId = await createAgent({
        name: 'ObjectDefaultsAgent',
        knowledgeConfig: { write_memory_id: memoryId, extraction: {} },
      });
      const convId = await createConversationWithMessage('I use vim.');

      mockCreateGeneration.mockResolvedValueOnce(
        completedGeneration('gen_ext_8', 'Noted.')
      );
      mockRunExtractionCompletion.mockResolvedValueOnce('["User uses vim"]');

      const res = await authenticatedTestClient(adminToken)
        .post(`/api/v1/conversations/${convId}/generate`)
        .send({ agent_id: agentId });
      expect(res.status).toBe(200);

      const entries = await waitForEntries(memoryId, 1);
      expect(entries).toHaveLength(1);

      const callArgs = mockRunExtractionCompletion.mock.calls[0][0];
      expect(callArgs.aiProviderId).toBeUndefined();
      expect(callArgs.model).toBeUndefined();
      expect(callArgs.prompt).toContain('discrete, atomic facts');
    });

    test('extraction object with enabled false does not trigger', async () => {
      const memoryId = await createMemory('Disabled Object Memory');
      const agentId = await createAgent({
        name: 'DisabledObjectAgent',
        knowledgeConfig: {
          write_memory_id: memoryId,
          extraction: { enabled: false, model: 'kept-but-off' },
        },
      });
      const convId = await createConversationWithMessage('Hello.');

      mockCreateGeneration.mockResolvedValueOnce(
        completedGeneration('gen_ext_9', 'Hi!')
      );

      const res = await authenticatedTestClient(adminToken)
        .post(`/api/v1/conversations/${convId}/generate`)
        .send({ agent_id: agentId });
      expect(res.status).toBe(200);

      await waitForNoExtractionAttempt();
      expect(mockRunExtractionCompletion).not.toHaveBeenCalled();
      expect(await listEntries(memoryId)).toHaveLength(0);
    });

    test('agent create round-trips the extraction object fields', async () => {
      const memoryId = await createMemory('Override Contract Memory');
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: 'OverrideContractAgent',
          knowledge_config: {
            write_memory_id: memoryId,
            extraction: {
              ai_provider_id: aiProviderId,
              model: 'small-model',
              prompt: 'Extract decisions only.',
            },
          },
        });

      expect(res.status).toBe(201);
      const extraction = res.body.knowledge_config.extraction;
      expect(extraction.ai_provider_id).toBe(aiProviderId);
      expect(extraction.model).toBe('small-model');
      expect(extraction.prompt).toBe('Extract decisions only.');
    });
  });

  describe('direct agent generation trigger', () => {
    test('extracts facts after POST /agents/:id/generate completes', async () => {
      const memoryId = await createMemory('Direct Extraction Memory');
      const agentId = await createAgent({
        name: 'DirectExtractionAgent',
        knowledgeConfig: { write_memory_id: memoryId, extraction: true },
      });

      mockCreateGeneration.mockResolvedValueOnce(
        completedGeneration('gen_ext_6', 'Friday it is.')
      );
      mockRunExtractionCompletion.mockResolvedValueOnce(
        '["Project deadline is Friday"]'
      );

      const res = await authenticatedTestClient(adminToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({
          messages: [{ role: 'user', content: 'The deadline is Friday.' }],
        });
      expect(res.status).toBe(200);

      const entries = await waitForEntries(memoryId, 1);
      expect(entries).toHaveLength(1);
      expect(entries[0].content).toBe('Project deadline is Friday');
      expect(entries[0].source_type).toBe('extraction');
    });
  });

  describe('per-turn extraction override (extract flag)', () => {
    test('extract: false suppresses extraction even when the agent enables it', async () => {
      const memoryId = await createMemory('Suppress Memory');
      const agentId = await createAgent({
        name: 'SuppressExtractionAgent',
        knowledgeConfig: { write_memory_id: memoryId, extraction: true },
      });

      mockCreateGeneration.mockResolvedValueOnce(
        completedGeneration('gen_ext_supp', 'Here are your tools.')
      );

      const res = await authenticatedTestClient(adminToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({
          messages: [{ role: 'user', content: 'List your tools.' }],
          extract: false,
        });
      expect(res.status).toBe(200);

      await waitForNoExtractionAttempt();
      expect(mockRunExtractionCompletion).not.toHaveBeenCalled();
      expect(await listEntries(memoryId)).toHaveLength(0);
    });

    test('extract: true forces extraction when the agent has a write memory but did not enable it', async () => {
      const memoryId = await createMemory('Force Memory');
      const agentId = await createAgent({
        name: 'ForceExtractionAgent',
        // write_memory_id present, but extraction not enabled by default
        knowledgeConfig: { write_memory_id: memoryId },
      });

      mockCreateGeneration.mockResolvedValueOnce(
        completedGeneration('gen_ext_force', 'Onboarding noted.')
      );
      mockRunExtractionCompletion.mockResolvedValueOnce(
        '["User onboarded on a Monday"]'
      );

      const res = await authenticatedTestClient(adminToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({
          messages: [{ role: 'user', content: 'I started on Monday.' }],
          extract: true,
        });
      expect(res.status).toBe(200);

      const entries = await waitForEntries(memoryId, 1);
      expect(entries).toHaveLength(1);
      expect(entries[0].content).toBe('User onboarded on a Monday');
      expect(entries[0].source_type).toBe('extraction');
    });
  });

  describe('read-time knowledge_config normalization (stale agents)', () => {
    test('extraction runs for an agent whose stored config is still snake_case', async () => {
      // Simulates a formation-deployed agent persisted before write-time
      // normalization: its knowledge_config blob is raw snake_case. Runtime
      // code reads camelCase, so without read-time normalization the write
      // memory and extraction flag would be invisible and extraction would
      // silently no-op. Seed the stale shape directly, since no current API
      // path produces it any more.
      const memoryId = await createMemory('Stale Config Memory');
      const agentId = await createAgent({ name: 'StaleConfigAgent' });

      await db.Agent.update(
        {
          knowledgeConfig: {
            write_memory_id: memoryId,
            extraction: true,
          },
        },
        { where: { publicId: agentId } }
      );

      mockCreateGeneration.mockResolvedValueOnce(
        completedGeneration('gen_ext_stale', 'Preference recorded.')
      );
      mockRunExtractionCompletion.mockResolvedValueOnce(
        '["User prefers dark mode"]'
      );

      const res = await authenticatedTestClient(adminToken)
        .post(`/api/v1/agents/${agentId}/generate`)
        .send({
          messages: [{ role: 'user', content: 'I prefer dark mode.' }],
        });
      expect(res.status).toBe(200);

      const entries = await waitForEntries(memoryId, 1);
      expect(entries).toHaveLength(1);
      expect(entries[0].content).toBe('User prefers dark mode');
      expect(entries[0].source_type).toBe('extraction');
    });
  });
});
