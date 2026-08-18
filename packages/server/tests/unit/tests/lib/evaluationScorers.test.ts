import {
  aggregateScores,
  resolveRunPassed,
} from 'src/lib/evaluationScorerAggregation';
import {
  buildJsonLogicContext,
  type EmbeddingScorerRunner,
  type JudgeRunner,
  scoreOutput,
  type ScorerOutcome,
  type ToolScorerRunner,
  validateScorers,
} from 'src/lib/evaluationScorers';

/**
 * Direct tests for the scorer kernel (the evaluations module doc).
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

  const runOne = async (args: {
    scorer: Record<string, unknown>;
    content: string;
    object?: unknown;
    expectedOutput?: string | null;
    itemMetadata?: unknown;
    agentOutputSchema?: unknown;
    runJudge?: JudgeRunner;
    runToolScorer?: ToolScorerRunner;
    runEmbeddings?: EmbeddingScorerRunner;
  }): Promise<ScorerOutcome> => {
    const outcomes = await scoreOutput({
      scorers: [args.scorer],
      input: [{ role: 'user', content: 'hi' }],
      output: output(args.content, args.object),
      expectedOutput: args.expectedOutput ?? null,
      itemMetadata: args.itemMetadata ?? null,
      agentOutputSchema: args.agentOutputSchema,
      runJudge: args.runJudge,
      runToolScorer: args.runToolScorer,
      runEmbeddings: args.runEmbeddings,
    });
    return outcomes[0];
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

    describe('llm_judge', () => {
      const judge = (overrides: Record<string, unknown> = {}) => {
        return {
          type: 'llm_judge',
          prompt: 'Rate {{output}} against {{expected}}',
          pass_threshold: 0.7,
          ...overrides,
        };
      };

      test('accepts a minimal judge config', () => {
        expect(validate([judge()])).toBeNull();
      });

      test.each([
        ['a missing prompt', { prompt: undefined }, /prompt is required/],
        ['an empty prompt', { prompt: '   ' }, /prompt is required/],
        [
          'a missing pass_threshold',
          { pass_threshold: undefined },
          /pass_threshold is required/,
        ],
        [
          'a pass_threshold above 1',
          { pass_threshold: 1.5 },
          /pass_threshold is required/,
        ],
        [
          'a pass_threshold below 0',
          { pass_threshold: -0.1 },
          /pass_threshold is required/,
        ],
        [
          'a non-numeric pass_threshold',
          { pass_threshold: '0.7' },
          /pass_threshold is required/,
        ],
        [
          'a non-string ai_provider_id',
          { ai_provider_id: 7 },
          /ai_provider_id must be an ai provider id/,
        ],
        ['a non-string model', { model: 7 }, /model must be a string/],
      ])('rejects %s', (_label, overrides, pattern) => {
        expect(validate([judge(overrides as Record<string, unknown>)])).toMatch(
          pattern as RegExp
        );
      });

      test('accepts a pinned provider and model', () => {
        expect(
          validate([judge({ ai_provider_id: 'aip_1', model: 'gpt-4o-mini' })])
        ).toBeNull();
      });
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

    test('accepts every scorer type together', () => {
      expect(
        validate(
          [
            { type: 'exact_match' },
            { type: 'contains', value: 'invoice', case_sensitive: true },
            { type: 'json_logic', expression: { '==': [1, 1] } },
            { type: 'output_schema' },
            {
              type: 'llm_judge',
              prompt: 'rate {{output}}',
              pass_threshold: 0.5,
            },
            { type: 'tool', name: 'toxicity', tool_id: 'tool_x1' },
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

    describe('tool', () => {
      const toolScorer = (overrides: Record<string, unknown> = {}) => {
        return {
          type: 'tool',
          name: 'toxicity',
          tool_id: 'tool_x1',
          ...overrides,
        };
      };

      test('accepts a minimal tool scorer', () => {
        expect(validate([toolScorer()])).toBeNull();
      });

      test('accepts the full config', () => {
        expect(
          validate([
            toolScorer({
              action: 'score-toxicity',
              preset_parameters: { model: 'small' },
              pass_threshold: 0.5,
            }),
          ])
        ).toBeNull();
      });

      test.each([
        ['a missing name', { name: undefined }, /name is required/],
        ['an empty name', { name: '  ' }, /name is required/],
        ['a non-string name', { name: 7 }, /name is required/],
        ['a missing tool_id', { tool_id: undefined }, /tool_id is required/],
        ['an empty tool_id', { tool_id: '' }, /tool_id is required/],
        ['a non-string action', { action: 7 }, /action must be a string/],
        [
          'non-object preset_parameters',
          { preset_parameters: 'x' },
          /preset_parameters must be an object/,
        ],
        [
          'a pass_threshold above 1',
          { pass_threshold: 1.5 },
          /pass_threshold must be a number between 0 and 1/,
        ],
        [
          'a non-numeric pass_threshold',
          { pass_threshold: '0.7' },
          /pass_threshold must be a number between 0 and 1/,
        ],
      ])('rejects %s', (_label, overrides, pattern) => {
        expect(
          validate([toolScorer(overrides as Record<string, unknown>)])
        ).toMatch(pattern as RegExp);
      });

      test('rejects a name that shadows a built-in scorer type', () => {
        // Aggregate scores are keyed by the outcome's scorer key, so a tool
        // scorer named like a built-in would collapse into its bucket.
        expect(validate([toolScorer({ name: 'contains' })])).toMatch(
          /must not be a built-in scorer type/
        );
      });

      test.each(['input', 'output', 'object', 'expected', 'item'])(
        'rejects the reserved preset key %s',
        (key) => {
          expect(
            validate([toolScorer({ preset_parameters: { [key]: 1 } })])
          ).toMatch(/reserved/);
        }
      );

      test('rejects two tool scorers sharing a name', () => {
        expect(
          validate([
            toolScorer(),
            toolScorer({ name: 'toxicity', tool_id: 'tool_x2' }),
          ])
        ).toMatch(/declared more than once/);
      });

      test('accepts two tool scorers with distinct names', () => {
        // Unlike built-in types, `tool` may appear several times — outcomes
        // key on the scorer's own name, so two names are two buckets.
        expect(
          validate([
            toolScorer(),
            toolScorer({ name: 'groundedness', tool_id: 'tool_x2' }),
          ])
        ).toBeNull();
      });
    });
  });

  // ── exact_match ──────────────────────────────────────────────────────────

  describe('exact_match', () => {
    test('scores 1 on an exact match, ignoring surrounding whitespace', async () => {
      expect(
        await runOne({
          scorer: { type: 'exact_match' },
          content: '  Paris\n',
          expectedOutput: 'Paris',
        })
      ).toEqual({ scorer: 'exact_match', score: 1, passed: true });
    });

    test('scores 0 on a different answer', async () => {
      expect(
        (
          await runOne({
            scorer: { type: 'exact_match' },
            content: 'Lyon',
            expectedOutput: 'Paris',
          })
        ).score
      ).toBe(0);
    });

    test('scores 0 when the item has no reference answer', async () => {
      expect(
        (
          await runOne({
            scorer: { type: 'exact_match' },
            content: 'Paris',
            expectedOutput: null,
          })
        ).passed
      ).toBe(false);
    });
  });

  // ── contains ─────────────────────────────────────────────────────────────

  describe('contains', () => {
    test('is case-insensitive by default', async () => {
      expect(
        (
          await runOne({
            scorer: { type: 'contains', value: 'INVOICE' },
            content: 'Your invoice is ready.',
          })
        ).score
      ).toBe(1);
    });

    test('respects case_sensitive: true', async () => {
      expect(
        (
          await runOne({
            scorer: {
              type: 'contains',
              value: 'INVOICE',
              case_sensitive: true,
            },
            content: 'Your invoice is ready.',
          })
        ).score
      ).toBe(0);
    });

    test('scores 0 when the value is absent', async () => {
      expect(
        (
          await runOne({
            scorer: { type: 'contains', value: 'refund' },
            content: 'Your invoice is ready.',
          })
        ).passed
      ).toBe(false);
    });
  });

  // ── json_logic ───────────────────────────────────────────────────────────

  describe('json_logic', () => {
    test('reads the output text through the `output` var', async () => {
      expect(
        (
          await runOne({
            scorer: {
              type: 'json_logic',
              expression: { '==': [{ var: 'output' }, 'yes'] },
            },
            content: 'yes',
          })
        ).score
      ).toBe(1);
    });

    test('reads structured output through the `object` var', async () => {
      expect(
        (
          await runOne({
            scorer: {
              type: 'json_logic',
              expression: { '==': [{ var: 'object.category' }, 'billing'] },
            },
            content: '{"category":"billing"}',
            object: { category: 'billing' },
          })
        ).score
      ).toBe(1);
    });

    test('compares structured output against the reference answer', async () => {
      expect(
        (
          await runOne({
            scorer: {
              type: 'json_logic',
              expression: {
                '==': [{ var: 'object.category' }, { var: 'expected' }],
              },
            },
            content: '{"category":"billing"}',
            object: { category: 'billing' },
            expectedOutput: 'billing',
          })
        ).passed
      ).toBe(true);
    });

    test('reads the item metadata', async () => {
      expect(
        (
          await runOne({
            scorer: {
              type: 'json_logic',
              expression: { '==': [{ var: 'item.metadata.topic' }, 'billing'] },
            },
            content: 'anything',
            itemMetadata: { topic: 'billing' },
          })
        ).score
      ).toBe(1);
    });

    test('an expression over `object` is falsy — not an error — with no structured output', async () => {
      expect(
        await runOne({
          scorer: {
            type: 'json_logic',
            expression: { '==': [{ var: 'object.category' }, 'billing'] },
          },
          content: 'plain text',
        })
      ).toEqual({ scorer: 'json_logic', score: 0, passed: false });
    });

    test('a truthy non-boolean result still scores 1', async () => {
      expect(
        (
          await runOne({
            scorer: { type: 'json_logic', expression: { cat: ['a', 'b'] } },
            content: 'anything',
          })
        ).score
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

    test('validates the structured object against the agent schema', async () => {
      expect(
        (
          await runOne({
            scorer: { type: 'output_schema' },
            content: '{"category":"billing"}',
            object: { category: 'billing' },
            agentOutputSchema: schema,
          })
        ).score
      ).toBe(1);
    });

    test('scores 0 when the object violates the schema', async () => {
      expect(
        (
          await runOne({
            scorer: { type: 'output_schema' },
            content: '{"category":"weather"}',
            object: { category: 'weather' },
            agentOutputSchema: schema,
          })
        ).score
      ).toBe(0);
    });

    test("uses the scorer's own schema verbatim over the agent's", async () => {
      // The agent's schema would accept this object; the scorer's does not —
      // proving the frozen criterion wins, which is what keeps two runs
      // comparable across an agent edit.
      expect(
        (
          await runOne({
            scorer: {
              type: 'output_schema',
              schema: { type: 'object', required: ['ticket_id'] },
            },
            content: '{"category":"billing"}',
            object: { category: 'billing' },
            agentOutputSchema: schema,
          })
        ).score
      ).toBe(0);
    });

    test('scores 0 when the generation produced no structured object', async () => {
      expect(
        await runOne({
          scorer: { type: 'output_schema' },
          content: 'plain text',
          agentOutputSchema: schema,
        })
      ).toEqual({ scorer: 'output_schema', score: 0, passed: false });
    });
  });

  // ── unhandled scorer type ────────────────────────────────────────────────

  describe('a scorer type the dispatch does not handle', () => {
    /**
     * `scoreOutput` used to end its switch on `case 'output_schema': default:`,
     * so any type it did not recognise was scored *as* `output_schema` — and
     * reported under that name. Nothing surfaced the substitution: the run
     * reached a terminal status carrying scores that were never computed from
     * the requested criterion, and `resolveRunPassed` fed that verdict to
     * eval-gated promotion.
     *
     * `validateScorers` rejects an unknown type at Eval create, so this is
     * reachable only from a stored Eval whose scorer type the running server
     * does not know — an older or newer writer, or a hand-edited row. Failing
     * closed is the safe half of that trade: `runEvalItem` catches the throw
     * and records an item **error**, which is excluded from the aggregates
     * rather than counted as a 0, so an unscorable item can never look like a
     * regression (`evaluationRunExecution.ts`).
     */
    test('fails the scorer instead of silently scoring it as output_schema', async () => {
      await expect(
        runOne({
          scorer: { type: 'regex_match', pattern: '^bill' },
          content: '{"category":"billing"}',
          object: { category: 'billing' },
          agentOutputSchema: { type: 'object' },
        })
      ).rejects.toThrow(/unhandled scorer type/i);
    });

    test('names the offending type so a stored Eval can be found', async () => {
      await expect(
        runOne({
          scorer: { type: 'regex_match' },
          content: 'anything',
        })
      ).rejects.toThrow(/regex_match/);
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

  // ── llm_judge ────────────────────────────────────────────────────────────

  describe('llm_judge', () => {
    const scorer = {
      type: 'llm_judge',
      prompt: 'Rate {{output}}',
      pass_threshold: 0.7,
    };

    const verdict = (score: number, reasoning?: string): JudgeRunner => {
      return () => {
        return Promise.resolve(
          reasoning === undefined ? { score } : { score, reasoning }
        );
      };
    };

    test('carries the judge score through and keeps its reasoning', async () => {
      expect(
        await runOne({
          scorer,
          content: 'Paris is the capital.',
          runJudge: verdict(0.82, 'Correct and complete.'),
        })
      ).toEqual({
        scorer: 'llm_judge',
        score: 0.82,
        passed: true,
        reasoning: 'Correct and complete.',
      });
    });

    test('omits reasoning when the judge gave none', async () => {
      expect(
        await runOne({ scorer, content: 'x', runJudge: verdict(0.9) })
      ).toEqual({ scorer: 'llm_judge', score: 0.9, passed: true });
    });

    // The gate boundary: a run-level verdict is built from these, so `passed`
    // has to flip exactly at the threshold, not near it.
    test.each([
      [0.69, false],
      [0.7, true],
      [0.71, true],
    ])('a score of %s passes: %s', async (score, expected) => {
      expect(
        (await runOne({ scorer, content: 'x', runJudge: verdict(score) }))
          .passed
      ).toBe(expected);
    });

    test('propagates a judge failure so the caller can error the item', async () => {
      // Never a score of 0: a judge that cannot answer says nothing about the
      // agent, and 0 would read as a behavioral regression.
      await expect(
        runOne({
          scorer,
          content: 'x',
          runJudge: () => {
            return Promise.reject(new Error('judge exploded'));
          },
        })
      ).rejects.toThrow('judge exploded');
    });

    test('receives the item input, output text and reference answer', async () => {
      let seen: unknown;
      await runOne({
        scorer,
        content: 'Paris',
        expectedOutput: 'Paris, France',
        runJudge: (args) => {
          seen = args;
          return Promise.resolve({ score: 1 });
        },
      });
      expect(seen).toEqual({
        scorer,
        input: [{ role: 'user', content: 'hi' }],
        output: 'Paris',
        expected: 'Paris, France',
      });
    });
  });

  // ── tool ─────────────────────────────────────────────────────────────────

  describe('tool', () => {
    const scorer = (overrides: Record<string, unknown> = {}) => {
      return {
        type: 'tool',
        name: 'toxicity',
        tool_id: 'tool_x1',
        ...overrides,
      };
    };

    const verdict = (result: {
      score: number;
      passed?: boolean;
      reasoning?: string;
    }): ToolScorerRunner => {
      return () => {
        return Promise.resolve(result);
      };
    };

    test('keys the outcome by the scorer name, not the type', async () => {
      expect(
        await runOne({
          scorer: scorer(),
          content: 'x',
          runToolScorer: verdict({ score: 0.8, passed: true }),
        })
      ).toEqual({ scorer: 'toxicity', score: 0.8, passed: true });
    });

    test('keeps the tool reasoning', async () => {
      expect(
        await runOne({
          scorer: scorer(),
          content: 'x',
          runToolScorer: verdict({
            score: 1,
            passed: true,
            reasoning: 'No slurs found.',
          }),
        })
      ).toEqual({
        scorer: 'toxicity',
        score: 1,
        passed: true,
        reasoning: 'No slurs found.',
      });
    });

    test('an explicit passed from the tool wins over the threshold', async () => {
      // The tool owns the algorithm, so its verdict is authoritative even when
      // the config also declares a threshold the score would clear.
      expect(
        (
          await runOne({
            scorer: scorer({ pass_threshold: 0.5 }),
            content: 'x',
            runToolScorer: verdict({ score: 0.9, passed: false }),
          })
        ).passed
      ).toBe(false);
    });

    // The fallback gate boundary: `>=`, so a score exactly at the threshold
    // passes — the same rule as llm_judge.
    test.each([
      [0.69, false],
      [0.7, true],
      [0.71, true],
    ])(
      'without a tool verdict, a score of %s at threshold 0.7 passes: %s',
      async (score, expected) => {
        expect(
          (
            await runOne({
              scorer: scorer({ pass_threshold: 0.7 }),
              content: 'x',
              runToolScorer: verdict({ score }),
            })
          ).passed
        ).toBe(expected);
      }
    );

    test('no tool verdict and no threshold errors the item, naming the scorer', async () => {
      // A scorer that cannot resolve pass/fail must error, never guess — the
      // same rule that keeps a failed judge from landing as a 0.
      await expect(
        runOne({
          scorer: scorer(),
          content: 'x',
          runToolScorer: verdict({ score: 0.6 }),
        })
      ).rejects.toThrow(/toxicity.*passed.*pass_threshold/);
    });

    test('propagates a tool failure so the caller can error the item', async () => {
      await expect(
        runOne({
          scorer: scorer(),
          content: 'x',
          runToolScorer: () => {
            return Promise.reject(new Error('scorer tool exploded'));
          },
        })
      ).rejects.toThrow('scorer tool exploded');
    });

    test('receives the scorer and the same context json_logic sees', async () => {
      let seen: unknown;
      await runOne({
        scorer: scorer(),
        content: 'Paris',
        object: { category: 'geo' },
        expectedOutput: 'Paris, France',
        itemMetadata: { topic: 'capitals' },
        runToolScorer: (args) => {
          seen = args;
          return Promise.resolve({ score: 1, passed: true });
        },
      });
      expect(seen).toEqual({
        scorer: scorer(),
        context: {
          input: [{ role: 'user', content: 'hi' }],
          output: 'Paris',
          object: { category: 'geo' },
          expected: 'Paris, France',
          item: { metadata: { topic: 'capitals' } },
        },
      });
    });
  });

  // ── embedding_similarity ─────────────────────────────────────────────────

  describe('embedding_similarity', () => {
    const scorer = (overrides: Record<string, unknown> = {}) => {
      return {
        type: 'embedding_similarity',
        pass_threshold: 0.8,
        ...overrides,
      };
    };

    const vectors = (
      byText: Record<string, number[]>
    ): EmbeddingScorerRunner => {
      return ({ texts }) => {
        return Promise.resolve(
          texts.map((text) => {
            return byText[text];
          })
        );
      };
    };

    describe('validation', () => {
      const validate = (config: Record<string, unknown>) => {
        return validateScorers({
          scorers: [config],
          agentHasOutputSchema: false,
        });
      };

      test('accepts a valid config', () => {
        expect(validate(scorer())).toBeNull();
      });

      test.each([
        ['missing', undefined],
        ['not a number', 'high'],
        ['below 0', -0.1],
        ['above 1', 1.1],
      ])('rejects a pass_threshold that is %s', (_label, pass_threshold) => {
        expect(validate(scorer({ pass_threshold }))).toContain(
          'scorers.0.pass_threshold'
        );
      });

      test('rejects unknown fields', () => {
        expect(validate(scorer({ model: 'x' }))).toContain('unknown field');
      });
    });

    test('scores the cosine similarity of the two embeddings', async () => {
      const outcome = await runOne({
        scorer: scorer(),
        content: 'The capital is Paris.',
        expectedOutput: 'Paris',
        runEmbeddings: vectors({
          'The capital is Paris.': [1, 1, 0],
          Paris: [1, 0, 0],
        }),
      });
      expect(outcome.scorer).toBe('embedding_similarity');
      expect(outcome.score).toBeCloseTo(Math.SQRT1_2, 10);
      expect(outcome.passed).toBe(false);
    });

    test('identical texts score 1 and pass', async () => {
      expect(
        await runOne({
          scorer: scorer(),
          content: 'Paris',
          expectedOutput: 'Paris',
          runEmbeddings: vectors({ Paris: [0.3, 0.4, 0] }),
        })
      ).toEqual({ scorer: 'embedding_similarity', score: 1, passed: true });
    });

    test('passes exactly at the threshold (>=)', async () => {
      const outcome = await runOne({
        scorer: scorer({ pass_threshold: 1 }),
        content: 'a',
        expectedOutput: 'b',
        // Parallel vectors: the cosine is exactly 1 (clamped), meeting a
        // threshold of 1 — proving `>=`, not `>`.
        runEmbeddings: vectors({ a: [2, 0], b: [1, 0] }),
      });
      expect(outcome.score).toBe(1);
      expect(outcome.passed).toBe(true);
    });

    test('clamps a negative cosine to 0', async () => {
      const outcome = await runOne({
        scorer: scorer(),
        content: 'a',
        expectedOutput: 'b',
        runEmbeddings: vectors({ a: [1, 0], b: [-1, 0] }),
      });
      expect(outcome).toEqual({
        scorer: 'embedding_similarity',
        score: 0,
        passed: false,
      });
    });

    test('a zero-magnitude embedding scores 0 instead of NaN', async () => {
      const outcome = await runOne({
        scorer: scorer(),
        content: 'a',
        expectedOutput: 'b',
        runEmbeddings: vectors({ a: [0, 0], b: [1, 0] }),
      });
      expect(outcome.score).toBe(0);
      expect(outcome.passed).toBe(false);
    });

    test('scores 0 without embedding when the item has no reference answer', async () => {
      let called = false;
      const outcome = await runOne({
        scorer: scorer(),
        content: 'Paris',
        expectedOutput: null,
        runEmbeddings: () => {
          called = true;
          return Promise.resolve([]);
        },
      });
      expect(outcome).toEqual({
        scorer: 'embedding_similarity',
        score: 0,
        passed: false,
      });
      expect(called).toBe(false);
    });

    test('an embedding failure propagates as an item error, never a 0', async () => {
      await expect(
        runOne({
          scorer: scorer(),
          content: 'Paris',
          expectedOutput: 'Paris',
          runEmbeddings: () => {
            return Promise.reject(new Error('embedding backend down'));
          },
        })
      ).rejects.toThrow('embedding backend down');
    });
  });
});
