import {
  parseFactCandidates,
  runBuiltInExtractor,
} from 'src/lib/memoryExtraction';
import * as extractionCompletionModule from 'src/lib/memoryExtractionCompletion';

// Shared spy created once at module load (the `mockCreateGeneration` pattern):
// `afterEach` uses `clearAllMocks`, never `restoreAllMocks`.
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

  describe('runBuiltInExtractor', () => {
    test('sends the rule prompt, the provider and the model it was given', async () => {
      mockRunExtractionCompletion.mockResolvedValueOnce('["a fact"]');

      const candidates = await runBuiltInExtractor({
        agentId: 'agent_source',
        transcript: 'user: hi\nassistant: hello',
        prompt: 'Only billing facts',
        aiProviderId: 'aip_cheap',
        model: 'cheap-model',
      });

      expect(candidates).toEqual(['a fact']);
      const call = mockRunExtractionCompletion.mock.calls[0][0];
      expect(call.agentId).toBe('agent_source');
      expect(call.aiProviderId).toBe('aip_cheap');
      expect(call.model).toBe('cheap-model');
      // A custom prompt replaces the task instructions only: the response
      // contract and the transcript are always appended.
      expect(call.prompt).toContain('Only billing facts');
      expect(call.prompt).toContain('Respond with a JSON array');
      expect(call.prompt).toContain('assistant: hello');
    });

    test('proposes nothing for an empty transcript, without calling the model', async () => {
      expect(
        await runBuiltInExtractor({ agentId: 'agent_source', transcript: '  ' })
      ).toEqual([]);
      expect(mockRunExtractionCompletion).not.toHaveBeenCalled();
    });

    test('proposes nothing when the completion fails, rather than throwing', async () => {
      mockRunExtractionCompletion.mockRejectedValueOnce(
        new Error('provider unavailable')
      );

      await expect(
        runBuiltInExtractor({
          agentId: 'agent_source',
          transcript: 'user: hi',
        })
      ).resolves.toEqual([]);
    });
  });
});
