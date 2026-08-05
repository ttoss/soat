import {
  resolveTraceContentMode,
  validateAgentTraceContentMode,
  validateTraceContentMode,
  validateTraceContentRetentionDays,
} from '../../../../src/lib/traceContentPolicy';

/**
 * Pure policy resolution: a large input space (two independent mode fields, a
 * nullable day count) whose branches are each a one-line rule. Driving these
 * through HTTP would need a project + agent per case and would report every
 * rejection as an indistinguishable `400` — the keep-list's "pure algorithm"
 * case (tests.md).
 */
describe('traceContentPolicy', () => {
  describe('validateTraceContentMode', () => {
    test.each(['full', 'none'])('accepts %s', (value) => {
      expect(validateTraceContentMode(value)).toBeNull();
    });

    test.each([
      ['an unknown string', 'partial'],
      ['the wrong case', 'None'],
      ['a number', 3],
      ['a boolean', true],
      ['an empty string', ''],
    ])('rejects %s', (_label, value) => {
      expect(validateTraceContentMode(value)).toMatch(/full.*none/);
    });

    test('rejects null — the project column is non-nullable', () => {
      expect(validateTraceContentMode(null)).toMatch(/full.*none/);
    });
  });

  describe('validateAgentTraceContentMode', () => {
    test('null inherits the project, whatever the project is', () => {
      expect(
        validateAgentTraceContentMode({ projectMode: 'none', agentMode: null })
      ).toBeNull();
      expect(
        validateAgentTraceContentMode({ projectMode: 'full', agentMode: null })
      ).toBeNull();
    });

    test('an agent may tighten a storing project to none', () => {
      expect(
        validateAgentTraceContentMode({
          projectMode: 'full',
          agentMode: 'none',
        })
      ).toBeNull();
    });

    test('an agent may restate none under a zero-retention project', () => {
      expect(
        validateAgentTraceContentMode({
          projectMode: 'none',
          agentMode: 'none',
        })
      ).toBeNull();
    });

    test('an agent may NOT loosen a zero-retention project back to full', () => {
      expect(
        validateAgentTraceContentMode({
          projectMode: 'none',
          agentMode: 'full',
        })
      ).toMatch(/cannot store content/i);
    });

    test('rejects an invalid agent mode before comparing to the project', () => {
      expect(
        validateAgentTraceContentMode({
          projectMode: 'full',
          agentMode: 'partial',
        })
      ).toMatch(/full.*none/);
    });
  });

  describe('resolveTraceContentMode', () => {
    test.each([
      ['full', null, 'full'],
      ['full', 'full', 'full'],
      ['full', 'none', 'none'],
      ['none', null, 'none'],
      ['none', 'none', 'none'],
      // Defence in depth: the write guard refuses this combination, but if a
      // row predates the guard the stricter side must still win at read time.
      ['none', 'full', 'none'],
    ] as const)(
      'project=%s agent=%s resolves to %s',
      (projectMode, agentMode, expected) => {
        expect(resolveTraceContentMode({ projectMode, agentMode })).toBe(
          expected
        );
      }
    );

    test('an unrecognised stored value is treated as none, not full', () => {
      // Fail closed: a corrupt/unknown mode must never be read as "store it".
      expect(
        resolveTraceContentMode({ projectMode: 'garbage', agentMode: null })
      ).toBe('none');
    });
  });

  describe('validateTraceContentRetentionDays', () => {
    test('null disables retention', () => {
      expect(validateTraceContentRetentionDays(null)).toBeNull();
    });

    test.each([1, 30, 90, 3650])('accepts %d days', (value) => {
      expect(validateTraceContentRetentionDays(value)).toBeNull();
    });

    test.each([
      ['zero', 0],
      ['a negative count', -1],
      ['a fraction', 1.5],
      ['a string', '30'],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
    ])('rejects %s', (_label, value) => {
      expect(validateTraceContentRetentionDays(value)).toMatch(
        /integer >= 1.*null/
      );
    });
  });
});
