import {
  criterionBindings,
  criterionRollups,
  validateCriteria,
} from 'src/lib/evaluationCriteria';

/**
 * Criteria (the evaluations module doc — Criteria): pure functions over the
 * eval's criteria and a run's results. The request schema refuses most bad
 * shapes before the route, and a formation template reaches the validator
 * with only its field list checked, so every shape is pinned here. The REST
 * wiring is `rest/evaluationsCriteria.test.ts`.
 */

const SCORERS = [
  { type: 'contains', name: 'a', value: 'x' },
  { type: 'contains', name: 'b', value: 'y' },
];

const PROBES = [
  { output: 'x', passed: true },
  { output: 'z', passed: false },
];

const criterion = (overrides: Record<string, unknown> = {}) => {
  return {
    name: 'c',
    description: 'd',
    scorers: ['a', 'b'],
    probes: PROBES,
    ...overrides,
  };
};

const validate = (criteria: unknown) => {
  return validateCriteria({ criteria, scorers: SCORERS });
};

describe('evaluationCriteria', () => {
  describe('validateCriteria', () => {
    test.each([undefined, null])('takes %s as no criteria', (criteria) => {
      expect(validate(criteria)).toBeNull();
    });

    test('takes criteria that place every scorer once', () => {
      expect(validate([criterion()])).toBeNull();
    });

    test.each([
      ['a non-array', 'c', /non-empty array/],
      ['an empty array', [], /non-empty array/],
      [
        'a criterion that is not an object',
        [1],
        /criteria\.0 must be an object/,
      ],
      ['an unknown field', [criterion({ weight: 1 })], /criteria\.0\.weight/],
      ['no name', [criterion({ name: undefined })], /criteria\.0\.name/],
      ['a blank name', [criterion({ name: ' ' })], /criteria\.0\.name/],
      [
        'no description',
        [criterion({ description: undefined })],
        /criteria\.0\.description/,
      ],
      [
        'scorers that are not an array',
        [criterion({ scorers: 'a' })],
        /criteria\.0\.scorers/,
      ],
      [
        'a scorer that is not a name',
        [criterion({ scorers: ['a', 1] })],
        /by name/,
      ],
      [
        'probes that are not an array',
        [criterion({ probes: 'p' })],
        /criteria\.0\.probes must be an array/,
      ],
      [
        'a probe that is not an object',
        [criterion({ probes: [1, PROBES[1]] })],
        /probes\.0 must be an object/,
      ],
      [
        'an unknown probe field',
        [criterion({ probes: [{ ...PROBES[0], weight: 1 }, PROBES[1]] })],
        /probes\.0\.weight/,
      ],
      [
        'a note that is not a string',
        [criterion({ probes: [{ ...PROBES[0], note: 1 }, PROBES[1]] })],
        /probes\.0\.note/,
      ],
      [
        'an expected_output that is not a string',
        [
          criterion({
            probes: [{ ...PROBES[0], expected_output: 1 }, PROBES[1]],
          }),
        ],
        /probes\.0\.expected_output/,
      ],
      [
        'probes that all pass',
        [criterion({ probes: [PROBES[0], PROBES[0]] })],
        /passes and one that fails/,
      ],
      [
        'a scorer in no criterion',
        [criterion({ scorers: ['a'] })],
        /Scorer 'b' sits in no criterion/,
      ],
    ])('refuses %s', (_label, criteria, message) => {
      expect(validate(criteria)).toMatch(message);
    });

    test('takes a probe with an input, a note and a null expected_output', () => {
      expect(
        validate([
          criterion({
            probes: [
              {
                ...PROBES[0],
                input: { a: 1 },
                note: 'n',
                expected_output: null,
              },
              PROBES[1],
            ],
          }),
        ])
      ).toBeNull();
    });

    test('reads the scorers it is given, skipping one that is not an object', () => {
      expect(
        validateCriteria({
          criteria: [criterion({ scorers: ['a'] })],
          scorers: [SCORERS[0], 'b'],
        })
      ).toBeNull();
      expect(
        validateCriteria({ criteria: [criterion()], scorers: 'none' })
      ).toMatch(/names 'a', which no scorer/);
    });
  });

  describe('criterionBindings', () => {
    test('reads nothing from a value that is not an array', () => {
      expect(criterionBindings(null)).toEqual([]);
    });

    test('skips an entry without a name and keeps only scorer names', () => {
      expect(
        criterionBindings([
          1,
          { scorers: ['a'] },
          { name: 'c', scorers: ['a', 2] },
          { name: 'd' },
        ])
      ).toEqual([
        { name: 'c', scorers: ['a'] },
        { name: 'd', scorers: [] },
      ]);
    });
  });

  describe('criterionRollups', () => {
    const result = (passes: boolean[], errored = false) => {
      return {
        datasetItemId: 1,
        errored,
        passed: false,
        scores: SCORERS.map((scorer, index) => {
          return {
            scorer: scorer.name,
            score: passes[index] ? 1 : 0,
            passed: passes[index],
          };
        }),
      };
    };

    test('reports nothing without criteria', () => {
      expect(criterionRollups({ criteria: null, results: [] })).toBeUndefined();
    });

    test('passes an item when every bound scorer passed, leaving errored items out', () => {
      const rollups = criterionRollups({
        criteria: [
          { name: 'both', scorers: ['a', 'b'] },
          { name: 'first', scorers: ['a'] },
        ],
        results: [
          result([true, true]),
          result([true, false]),
          result([false, false], true),
        ],
      });
      expect(rollups).toMatchObject({
        both: { pass_rate: 0.5, scored_item_count: 2 },
        first: { pass_rate: 1, scored_item_count: 2 },
      });
    });

    test('a run that scored nothing has no pass rate', () => {
      expect(
        criterionRollups({
          criteria: [{ name: 'first', scorers: ['a'] }],
          results: [],
        })
      ).toEqual({
        first: {
          pass_rate: null,
          pass_rate_interval: null,
          scored_item_count: 0,
        },
      });
    });
  });
});
