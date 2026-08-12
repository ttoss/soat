import {
  aggregateScores,
  buildJsonLogicContext,
  resolveRunPassed,
  scoreOutput,
  type ScorerOutcome,
  validateScorers,
} from 'src/lib/evaluationScorers';

/**
 * Direct tests for the scorer kernel (docs/prd-evaluations.md).
 *
 * These live in `lib/` under the keep-list rule: the scorers are pure
 * algorithms with a large input space, and reaching a single branch through
 * REST would need a whole project + agent + dataset + run per case, with the
 * failure signal reduced to one item's 0/1 (`.claude/rules/tests.md`).
 * The wiring — that a run actually calls these, freezes its inputs, and
 * persists the outcome — is covered at the entry point in
 * `rest/evaluations.test.ts`.
 */
describe('evaluation scorers', () => {
  const output = (content: string, object?: unknown) => {
    return object === undefined ? { content } : { content, object };
  };

  const runOne = (args: {
    scorer: Record<string, unknown>;
    content: string;
    object?: unknown;
    expectedOutput?: string | null;
    itemMetadata?: unknown;
    agentOutputSchema?: unknown;
  }): ScorerOutcome => {
    return scoreOutput({
      scorers: [args.scorer],
      input: [{ role: 'user', content: 'hi' }],
      output: output(args.content, args.object),
      expectedOutput: args.expectedOutput ?? null,
      itemMetadata: args.itemMetadata ?? null,
      agentOutputSchema: args.agentOutputSchema,
    })[0];
  };

  // ── validateScorers ──────────────────────────────────────────────────────

  describe('validateScorers', () => {
    const validate = (scorers: unknown, agentHasOutputSchema = false) => {
      return validateScorers({ scorers, agentHasOutputSchema });
    };

    test.each([
      ['not an array', 'nope'],
      ['an empty array', []],
    ])('rejects %s', (_label, scorers) => {
      expect(validate(scorers)).toMatch(/non-empty array/);
    });

    test('rejects a non-object entry', () => {
      expect(validate(['exact_match'])).toBe('scorers.0 must be an object.');
    });

    test('rejects an unknown type, naming the field', () => {
      const message = validate([{ type: 'vibes' }]);
      expect(message).toContain('scorers.0.type');
      expect(message).toContain('exact_match');
    });

    test('rejects llm_judge as a Phase 2 scorer rather than as unknown', () => {
      expect(validate([{ type: 'llm_judge' }])).toMatch(/Phase 2/);
    });

    test('rejects a config field the type does not accept', () => {
      expect(validate([{ type: 'exact_match', value: 'x' }])).toBe(
        "scorers.0 has unknown field(s) for type 'exact_match': value."
      );
    });

    test('rejects a duplicated scorer type', () => {
      const message = validate([
        { type: 'contains', value: 'a' },
        { type: 'contains', value: 'b' },
      ]);
      expect(message).toMatch(/declared more than once/);
    });

    test.each([
      ['a missing value', { type: 'contains' }, /value is required/],
      [
        'a non-boolean case_sensitive',
        { type: 'contains', value: 'a', case_sensitive: 'yes' },
        /case_sensitive must be a boolean/,
      ],
      [
        'a missing expression',
        { type: 'json_logic' },
        /expression is required/,
      ],
    ])('rejects %s', (_label, scorer, pattern) => {
      expect(validate([scorer])).toMatch(pattern as RegExp);
    });

    test('accepts the four Phase 1 scorers together', () => {
      expect(
        validate(
          [
            { type: 'exact_match' },
            { type: 'contains', value: 'invoice', case_sensitive: true },
            { type: 'json_logic', expression: { '==': [1, 1] } },
            { type: 'output_schema' },
          ],
          true
        )
      ).toBeNull();
    });

    describe('output_schema requires an agent schema', () => {
      test('rejects when the agent has none, even with its own schema', () => {
        const message = validate(
          [{ type: 'output_schema', schema: { type: 'object' } }],
          false
        );
        expect(message).toMatch(/requires the agent under test/);
      });

      test('accepts when the agent has one and the scorer omits its own', () => {
        expect(validate([{ type: 'output_schema' }], true)).toBeNull();
      });

      test('rejects a non-object schema', () => {
        expect(
          validate([{ type: 'output_schema', schema: 'object' }], true)
        ).toMatch(/must be a JSON Schema object/);
      });
    });
  });

  // ── exact_match ──────────────────────────────────────────────────────────

  describe('exact_match', () => {
    test('scores 1 on an exact match, ignoring surrounding whitespace', () => {
      expect(
        runOne({
          scorer: { type: 'exact_match' },
          content: '  Paris\n',
          expectedOutput: 'Paris',
        })
      ).toEqual({ scorer: 'exact_match', score: 1, passed: true });
    });

    test('scores 0 on a different answer', () => {
      expect(
        runOne({
          scorer: { type: 'exact_match' },
          content: 'Lyon',
          expectedOutput: 'Paris',
        }).score
      ).toBe(0);
    });

    test('scores 0 when the item has no reference answer', () => {
      expect(
        runOne({
          scorer: { type: 'exact_match' },
          content: 'Paris',
          expectedOutput: null,
        }).passed
      ).toBe(false);
    });
  });

  // ── contains ─────────────────────────────────────────────────────────────

  describe('contains', () => {
    test('is case-insensitive by default', () => {
      expect(
        runOne({
          scorer: { type: 'contains', value: 'INVOICE' },
          content: 'Your invoice is ready.',
        }).score
      ).toBe(1);
    });

    test('respects case_sensitive: true', () => {
      expect(
        runOne({
          scorer: { type: 'contains', value: 'INVOICE', case_sensitive: true },
          content: 'Your invoice is ready.',
        }).score
      ).toBe(0);
    });

    test('scores 0 when the value is absent', () => {
      expect(
        runOne({
          scorer: { type: 'contains', value: 'refund' },
          content: 'Your invoice is ready.',
        }).passed
      ).toBe(false);
    });
  });

  // ── json_logic ───────────────────────────────────────────────────────────

  describe('json_logic', () => {
    test('reads the output text through the `output` var', () => {
      expect(
        runOne({
          scorer: {
            type: 'json_logic',
            expression: { '==': [{ var: 'output' }, 'yes'] },
          },
          content: 'yes',
        }).score
      ).toBe(1);
    });

    test('reads structured output through the `object` var', () => {
      expect(
        runOne({
          scorer: {
            type: 'json_logic',
            expression: { '==': [{ var: 'object.category' }, 'billing'] },
          },
          content: '{"category":"billing"}',
          object: { category: 'billing' },
        }).score
      ).toBe(1);
    });

    test('compares structured output against the reference answer', () => {
      expect(
        runOne({
          scorer: {
            type: 'json_logic',
            expression: {
              '==': [{ var: 'object.category' }, { var: 'expected' }],
            },
          },
          content: '{"category":"billing"}',
          object: { category: 'billing' },
          expectedOutput: 'billing',
        }).passed
      ).toBe(true);
    });

    test('reads the item metadata', () => {
      expect(
        runOne({
          scorer: {
            type: 'json_logic',
            expression: { '==': [{ var: 'item.metadata.topic' }, 'billing'] },
          },
          content: 'anything',
          itemMetadata: { topic: 'billing' },
        }).score
      ).toBe(1);
    });

    test('an expression over `object` is falsy — not an error — with no structured output', () => {
      expect(
        runOne({
          scorer: {
            type: 'json_logic',
            expression: { '==': [{ var: 'object.category' }, 'billing'] },
          },
          content: 'plain text',
        })
      ).toEqual({ scorer: 'json_logic', score: 0, passed: false });
    });

    test('a truthy non-boolean result still scores 1', () => {
      expect(
        runOne({
          scorer: { type: 'json_logic', expression: { cat: ['a', 'b'] } },
          content: 'anything',
        }).score
      ).toBe(1);
    });
  });

  describe('buildJsonLogicContext', () => {
    test('omits `object` entirely for an agent with no output_schema', () => {
      const context = buildJsonLogicContext({
        input: [],
        output: { content: 'text' },
        expectedOutput: null,
        itemMetadata: null,
      });
      expect('object' in context).toBe(false);
    });

    test('includes `object` when the generation produced one', () => {
      const context = buildJsonLogicContext({
        input: [],
        output: { content: '{}', object: { a: 1 } },
        expectedOutput: null,
        itemMetadata: null,
      });
      expect(context.object).toEqual({ a: 1 });
    });
  });

  // ── output_schema ────────────────────────────────────────────────────────

  describe('output_schema', () => {
    const schema = {
      type: 'object',
      required: ['category'],
      properties: { category: { type: 'string', enum: ['billing', 'other'] } },
    };

    test('validates the structured object against the agent schema', () => {
      expect(
        runOne({
          scorer: { type: 'output_schema' },
          content: '{"category":"billing"}',
          object: { category: 'billing' },
          agentOutputSchema: schema,
        }).score
      ).toBe(1);
    });

    test('scores 0 when the object violates the schema', () => {
      expect(
        runOne({
          scorer: { type: 'output_schema' },
          content: '{"category":"weather"}',
          object: { category: 'weather' },
          agentOutputSchema: schema,
        }).score
      ).toBe(0);
    });

    test("uses the scorer's own schema verbatim over the agent's", () => {
      // The agent's schema would accept this object; the scorer's does not —
      // proving the frozen criterion wins, which is what keeps two runs
      // comparable across an agent edit.
      expect(
        runOne({
          scorer: {
            type: 'output_schema',
            schema: { type: 'object', required: ['ticket_id'] },
          },
          content: '{"category":"billing"}',
          object: { category: 'billing' },
          agentOutputSchema: schema,
        }).score
      ).toBe(0);
    });

    test('scores 0 when the generation produced no structured object', () => {
      expect(
        runOne({
          scorer: { type: 'output_schema' },
          content: 'plain text',
          agentOutputSchema: schema,
        })
      ).toEqual({ scorer: 'output_schema', score: 0, passed: false });
    });
  });

  // ── aggregation ──────────────────────────────────────────────────────────

  describe('aggregateScores', () => {
    const outcome = (
      scores: Array<[string, number]>,
      passed: boolean,
      errored = false
    ) => {
      return {
        scores: scores.map(([scorer, score]) => {
          return { scorer, score, passed: score === 1 };
        }),
        passed,
        errored,
      };
    };

    test('reports per-scorer mean and pass rate, plus the run pass rate', () => {
      const aggregate = aggregateScores({
        results: [
          outcome(
            [
              ['exact_match', 1],
              ['contains', 1],
            ],
            true
          ),
          outcome(
            [
              ['exact_match', 0],
              ['contains', 1],
            ],
            false
          ),
        ],
      });

      expect(aggregate.scorers.exact_match).toEqual({
        mean: 0.5,
        pass_rate: 0.5,
      });
      expect(aggregate.scorers.contains).toEqual({ mean: 1, pass_rate: 1 });
      expect(aggregate.pass_rate).toBe(0.5);
      expect(aggregate.scored_item_count).toBe(2);
    });

    test('excludes errored items rather than counting them as failures', () => {
      const aggregate = aggregateScores({
        results: [
          outcome([['exact_match', 1]], true),
          outcome([], false, true),
        ],
      });

      expect(aggregate.scored_item_count).toBe(1);
      expect(aggregate.pass_rate).toBe(1);
      expect(aggregate.scorers.exact_match.mean).toBe(1);
    });

    test('reports a null pass rate when nothing was scorable', () => {
      const aggregate = aggregateScores({
        results: [outcome([], false, true)],
      });
      expect(aggregate.pass_rate).toBeNull();
      expect(aggregate.scorers).toEqual({});
    });
  });

  // ── run verdict ──────────────────────────────────────────────────────────

  describe('resolveRunPassed', () => {
    const aggregate = (passRate: number | null) => {
      return { scorers: {}, pass_rate: passRate, scored_item_count: 1 };
    };

    test('is null when the eval declares no threshold', () => {
      expect(
        resolveRunPassed({ passThreshold: null, aggregate: aggregate(0) })
      ).toBeNull();
    });

    test.each([
      [0.8, 0.8, true],
      [0.8, 0.79, false],
      [0.8, 1, true],
    ])(
      'threshold %s against pass rate %s → %s',
      (threshold, passRate, expected) => {
        expect(
          resolveRunPassed({
            passThreshold: threshold,
            aggregate: aggregate(passRate),
          })
        ).toBe(expected);
      }
    );

    test('a run that measured nothing does not pass', () => {
      expect(
        resolveRunPassed({ passThreshold: 0, aggregate: aggregate(null) })
      ).toBe(false);
    });
  });
});
