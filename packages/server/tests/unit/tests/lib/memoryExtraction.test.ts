import {
  fireMemoryExtraction,
  parseFactCandidates,
  runMemoryExtraction,
} from 'src/lib/memoryExtraction';
import * as extractionCompletionModule from 'src/lib/memoryExtractionCompletion';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

const mockRunExtractionCompletion = jest.spyOn(
  extractionCompletionModule,
  'runExtractionCompletion'
);

describe('memoryExtraction lib', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('parseFactCandidates', () => {
    test('parses a plain JSON array of strings', () => {
      expect(parseFactCandidates('["a", "b"]')).toEqual(['a', 'b']);
    });

    test('parses an array wrapped in a fenced code block', () => {
      const text = '```json\n["fact one", "fact two"]\n```';
      expect(parseFactCandidates(text)).toEqual(['fact one', 'fact two']);
    });

    test('parses an array surrounded by prose', () => {
      const text = 'Here are the facts:\n["only fact"]\nThat is all.';
      expect(parseFactCandidates(text)).toEqual(['only fact']);
    });

    test('accepts objects with a content field', () => {
      const text = '[{"content": "fact A"}, {"content": "fact B"}]';
      expect(parseFactCandidates(text)).toEqual(['fact A', 'fact B']);
    });

    test('filters out non-string, empty, and malformed items', () => {
      const text = '["ok", 42, null, "", {"nope": true}]';
      expect(parseFactCandidates(text)).toEqual(['ok']);
    });

    test('returns an empty array for non-JSON text', () => {
      expect(parseFactCandidates('no facts here')).toEqual([]);
    });

    test('caps the number of candidates at 20', () => {
      const many = JSON.stringify(
        Array.from({ length: 25 }, (_, i) => {
          return `fact ${i}`;
        })
      );
      expect(parseFactCandidates(many)).toHaveLength(20);
    });
  });

  describe('runMemoryExtraction', () => {
    let adminToken: string;
    let projectId: string;
    let aiProviderId: string;

    beforeAll(async () => {
      await testClient
        .post('/api/v1/users/bootstrap')
        .send({ username: 'extractionlibadmin', password: 'supersecret' });

      adminToken = await loginAs('extractionlibadmin', 'supersecret');

      const projectRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'Extraction Lib Project' });
      projectId = projectRes.body.id;

      const aiProvRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: projectId,
          name: 'ExtractionLibProvider',
          provider: 'ollama',
          default_model: 'llama3.2',
        });
      aiProviderId = aiProvRes.body.id;
    });

    test('survives a failing extraction completion without throwing', async () => {
      const memoryRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/memories')
        .send({ project_id: projectId, name: 'Lib Failing Memory' });

      const agentRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          project_id: projectId,
          ai_provider_id: aiProviderId,
          name: 'LibFailingAgent',
          knowledge_config: {
            write_memory_id: memoryRes.body.id,
            extraction: true,
          },
        });

      mockRunExtractionCompletion.mockRejectedValueOnce(
        new Error('provider unavailable')
      );

      const summary = await runMemoryExtraction({
        agentId: agentRes.body.id,
        messages: [{ role: 'user', content: 'hi' }],
        assistantContent: 'hello',
      });

      expect(summary).toBeNull();
    });
  });

  describe('fireMemoryExtraction', () => {
    test('does not throw when runMemoryExtraction rejects', async () => {
      expect(() => {
        return fireMemoryExtraction({
          agentId: 'agt_fire_test',
          // An invalid projectIds value makes the underlying Agent lookup
          // reject (invalid input syntax for integer), forcing
          // runMemoryExtraction's promise to reject so the fire-and-forget
          // `.catch` handler runs.
          projectIds: ['not-a-number'] as unknown as number[],
          messages: [{ role: 'user', content: 'hi' }],
          assistantContent: 'hello',
        });
      }).not.toThrow();

      // Flush the microtask queue so the fire-and-forget `.catch` runs.
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
    });
  });
});
