import { parseFactCandidates } from 'src/lib/memoryExtraction';

/**
 * The parser every built-in extraction reply is read through: a pure function
 * over a large input space, where driving each shape through a firing rule
 * would cost a turn and a completion apiece to assert the same thing at lower
 * resolution. The extractor itself runs end to end in
 * `rest/memoryExtraction.test.ts`.
 */
describe('memoryExtraction lib', () => {
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
});
