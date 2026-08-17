import { parseToolScorerOutput } from 'src/lib/evaluationToolScorer';

/**
 * Direct tests for the tool scorer's output contract (the evaluations module
 * doc — Custom scorers). Lives in `lib/` under keep-list rule 1: the parser is
 * a pure function whose input space (every shape a user's tool might answer
 * with) is expensive to drive through a run per case, and the failure signal
 * there is one item's opaque `error` string.
 *
 * The wiring — that a run actually invokes the tool and records a parse
 * failure as an item-level error — is covered at the entry point in
 * `rest/evaluations.test.ts`.
 */
describe('evaluation tool scorer', () => {
  describe('parseToolScorerOutput', () => {
    test('accepts a bare result object', () => {
      expect(parseToolScorerOutput({ score: 0.8 })).toEqual({ score: 0.8 });
    });

    test('keeps an explicit passed verdict', () => {
      expect(parseToolScorerOutput({ score: 0.2, passed: true })).toEqual({
        score: 0.2,
        passed: true,
      });
    });

    test('keeps a reasoning string', () => {
      expect(
        parseToolScorerOutput({ score: 1, passed: true, reasoning: 'clean' })
      ).toEqual({ score: 1, passed: true, reasoning: 'clean' });
    });

    test('omits an empty reasoning string rather than carrying it', () => {
      expect(parseToolScorerOutput({ score: 1, reasoning: '' })).toEqual({
        score: 1,
      });
    });

    test('omits a non-string reasoning', () => {
      expect(parseToolScorerOutput({ score: 1, reasoning: 42 })).toEqual({
        score: 1,
      });
    });

    test('rejects a non-boolean passed instead of coercing it', () => {
      // `passed` decides the verdict — a tool answering `passed: "false"`
      // must surface as a contract violation, not silently fall through to
      // the threshold as if the tool had said nothing.
      expect(() => {
        return parseToolScorerOutput({ score: 1, passed: 'false' });
      }).toThrow(/passed.*boolean/);
    });

    // A string result covers an MCP tool's text content and an http target
    // answering `text/plain` — the same leniency parseJudgeVerdict extends
    // to a fenced or prose-wrapped model reply.
    test('parses a JSON object out of a string result', () => {
      expect(parseToolScorerOutput('{"score": 0.5, "passed": false}')).toEqual({
        score: 0.5,
        passed: false,
      });
    });

    test('parses JSON wrapped in prose and a code fence', () => {
      expect(
        parseToolScorerOutput('Result:\n```json\n{"score": 1}\n```\n')
      ).toEqual({ score: 1 });
    });

    test.each([
      ['a string with no JSON object', 'all good'],
      ['an array', [{ score: 1 }]],
      ['null', null],
      ['a bare number', 0.9],
    ])('rejects %s', (_label, raw) => {
      expect(() => {
        return parseToolScorerOutput(raw);
      }).toThrow(/did not answer with/);
    });

    test.each([
      ['a missing score', {}],
      ['a non-numeric score', { score: '0.9' }],
      ['a NaN score', { score: Number.NaN }],
    ])('rejects %s', (_label, raw) => {
      expect(() => {
        return parseToolScorerOutput(raw);
      }).toThrow(/score is not a number/);
    });

    test.each([
      ['above 1', 1.1],
      ['below 0', -0.1],
    ])('rejects a score %s', (_label, score) => {
      expect(() => {
        return parseToolScorerOutput({ score });
      }).toThrow(/outside the 0–1 range/);
    });
  });
});
