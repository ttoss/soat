import { failedProbes, runProbes } from 'src/lib/evaluationProbes';

/**
 * Probes (the evaluations module doc — Criteria): graded through the scorer
 * kernel with injected runners, so each reading of a stored criterion is
 * pinned here. The REST wiring is `rest/evaluationsProbes.test.ts`.
 */

const SCORERS = [
  { type: 'exact_match', name: 'exact' },
  { type: 'llm_judge', name: 'judge', prompt: 'p', pass_threshold: 0.5 },
];

describe('evaluationProbes', () => {
  test('reports no probes for criteria that are not an array', async () => {
    expect(
      await runProbes({
        criteria: null,
        scorers: SCORERS,
        agentOutputSchema: null,
        errors: 'record',
        runners: {},
      })
    ).toEqual({ passed: true, probes: [] });
  });

  test('grades a probe against its expected_output, skipping malformed criteria and probes', async () => {
    const report = await runProbes({
      criteria: [
        1,
        { scorers: ['exact'] },
        {
          name: 'matches',
          scorers: ['exact'],
          probes: [
            1,
            { passed: true },
            { output: 'yes', passed: true, expected_output: 'yes', input: 'q' },
            { output: 'no', passed: false, expected_output: 'yes' },
          ],
        },
        { name: 'none', scorers: 'exact', probes: 'p' },
      ],
      scorers: ['not a scorer', ...SCORERS],
      agentOutputSchema: null,
      errors: 'record',
      runners: {},
    });

    expect(report.passed).toBe(true);
    expect(report.probes).toEqual([
      expect.objectContaining({ criterion: 'matches', index: 0, held: true }),
      expect.objectContaining({ criterion: 'matches', index: 1, held: true }),
    ]);
  });

  test('a scorer that cannot grade records the error, and the probe does not hold', async () => {
    const report = await runProbes({
      criteria: [
        {
          name: 'judged',
          scorers: ['judge'],
          probes: [{ output: 'x', passed: true }],
        },
      ],
      scorers: SCORERS,
      agentOutputSchema: null,
      errors: 'record',
      runners: {
        runJudge: () => {
          return Promise.reject(new Error('provider down'));
        },
      },
    });

    expect(report.passed).toBe(false);
    expect(failedProbes(report)).toEqual([
      {
        criterion: 'judged',
        index: 0,
        expected: true,
        passed: false,
        error: expect.objectContaining({ code: 'EVAL_SCORING_FAILED' }),
      },
    ]);
  });

  test('names a probe that does not hold without an error', async () => {
    const report = await runProbes({
      criteria: [
        {
          name: 'matches',
          scorers: ['exact'],
          probes: [{ output: 'no', passed: true, expected_output: 'yes' }],
        },
      ],
      scorers: SCORERS,
      agentOutputSchema: null,
      errors: 'record',
      runners: {},
    });
    expect(failedProbes(report)).toEqual([
      { criterion: 'matches', index: 0, expected: true, passed: false },
    ]);
  });

  test('with errors thrown, a scorer that cannot grade fails the grading with its own error', async () => {
    await expect(
      runProbes({
        criteria: [
          {
            name: 'judged',
            scorers: ['judge'],
            probes: [{ output: 'x', passed: true }],
          },
        ],
        scorers: SCORERS,
        agentOutputSchema: null,
        errors: 'throw',
        runners: {
          runJudge: () => {
            return Promise.reject(new Error('provider down'));
          },
        },
      })
    ).rejects.toThrow('provider down');
  });

  test('grades the structured object of a probe as the output a schema scorer reads', async () => {
    const report = await runProbes({
      criteria: [
        {
          name: 'shaped',
          scorers: ['shape'],
          probes: [
            { output: '{}', object: { amount: 1 }, passed: true },
            { output: 'none', passed: false },
          ],
        },
      ],
      scorers: [
        {
          type: 'output_schema',
          name: 'shape',
          schema: {
            type: 'object',
            required: ['amount'],
            properties: { amount: { type: 'number' } },
          },
        },
      ],
      agentOutputSchema: null,
      errors: 'record',
      runners: {},
    });
    expect(report.passed).toBe(true);
  });
});
