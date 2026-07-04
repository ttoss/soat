import {
  buildReasoningProviderOptions,
  resolveReasoningConfig,
  validateReasoningConfig,
} from 'src/lib/reasoning';

describe('reasoning lib', () => {
  describe('resolveReasoningConfig', () => {
    test('returns the agent config when no override is given', () => {
      const config = { mode: 'pipeline', steps: [{ name: 'a', prompt: 'x' }] };
      expect(resolveReasoningConfig({ agentConfig: config })).toEqual(config);
    });

    test('the per-generate override replaces the agent config entirely', () => {
      expect(
        resolveReasoningConfig({
          agentConfig: { mode: 'pipeline', effort: 'high', steps: [] },
          override: { effort: 'low' },
        })
      ).toEqual({ effort: 'low' });
    });

    test('returns null when nothing is configured or mode is none', () => {
      expect(resolveReasoningConfig({})).toBeNull();
      expect(resolveReasoningConfig({ agentConfig: null })).toBeNull();
      expect(
        resolveReasoningConfig({ agentConfig: { mode: 'none' } })
      ).toBeNull();
    });

    test('ignores non-object configs', () => {
      expect(
        resolveReasoningConfig({ agentConfig: 'pipeline' as never })
      ).toBeNull();
    });
  });

  describe('buildReasoningProviderOptions', () => {
    test('maps effort to openai reasoningEffort', () => {
      expect(
        buildReasoningProviderOptions({ provider: 'openai', effort: 'high' })
      ).toEqual({
        providerOptions: { openai: { reasoningEffort: 'high' } },
      });
    });

    test('maps effort to anthropic thinking budget with raised output cap', () => {
      const result = buildReasoningProviderOptions({
        provider: 'anthropic',
        effort: 'medium',
      });
      expect(result?.providerOptions.anthropic).toEqual({
        thinking: { type: 'enabled', budgetTokens: 16384 },
      });
      // Anthropic requires max_tokens to exceed the thinking budget.
      expect(result?.maxOutputTokens).toBeGreaterThan(16384);
    });

    test('maps effort to google thinking budget', () => {
      expect(
        buildReasoningProviderOptions({ provider: 'google', effort: 'low' })
      ).toEqual({
        providerOptions: {
          google: { thinkingConfig: { thinkingBudget: 4096 } },
        },
      });
    });

    test('returns undefined for unsupported providers and missing effort', () => {
      expect(
        buildReasoningProviderOptions({ provider: 'ollama', effort: 'high' })
      ).toBeUndefined();
      expect(
        buildReasoningProviderOptions({ provider: 'openai' })
      ).toBeUndefined();
      expect(
        buildReasoningProviderOptions({
          provider: 'openai',
          effort: 'extreme' as never,
        })
      ).toBeUndefined();
    });
  });

  describe('validateReasoningConfig', () => {
    const expectCode = (fn: () => void, code: string) => {
      try {
        fn();
        throw new Error('expected validateReasoningConfig to throw');
      } catch (error) {
        expect((error as { code?: string }).code).toBe(code);
      }
    };

    test('accepts null, effort-only, and mode:none configs', () => {
      expect(() => {
        return validateReasoningConfig(null);
      }).not.toThrow();
      expect(() => {
        return validateReasoningConfig(undefined);
      }).not.toThrow();
      expect(() => {
        return validateReasoningConfig({ effort: 'high' });
      }).not.toThrow();
      expect(() => {
        return validateReasoningConfig({ mode: 'none' });
      }).not.toThrow();
    });

    test('accepts a single implicit-branch step (today’s "completion")', () => {
      expect(() => {
        return validateReasoningConfig({
          mode: 'pipeline',
          steps: [{ name: 'final', prompt: 'Refine: {draft}', output: true }],
        });
      }).not.toThrow();
    });

    test('accepts a valid pipeline with independent branches and a synthesis step', () => {
      expect(() => {
        return validateReasoningConfig({
          mode: 'pipeline',
          steps: [
            {
              name: 'angles',
              branches: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
              prompt: 'a {question}',
            },
            { name: 'final', prompt: 'b {steps.angles}', output: true },
          ],
        });
      }).not.toThrow();
    });

    test('accepts a debate step with rounds > 1 that references {transcript}', () => {
      expect(() => {
        return validateReasoningConfig({
          mode: 'pipeline',
          steps: [
            {
              name: 'debate',
              rounds: 2,
              branches: [
                { name: 'Optimist', prompt: 'Argue for. {transcript}' },
                { name: 'Skeptic', prompt: 'Argue against. {transcript}' },
              ],
            },
            {
              name: 'final',
              prompt: 'Synthesize {steps.debate}',
              output: true,
            },
          ],
        });
      }).not.toThrow();
    });

    test('a single-branch step may omit branches entirely and still use rounds:1', () => {
      expect(() => {
        return validateReasoningConfig({
          mode: 'pipeline',
          steps: [{ name: 'only', prompt: 'p {question}', rounds: 1 }],
        });
      }).not.toThrow();
    });

    test('accepts {steps.x.last} referencing a single-branch step', () => {
      expect(() => {
        return validateReasoningConfig({
          mode: 'pipeline',
          steps: [
            { name: 'draft', prompt: 'p' },
            { name: 'final', prompt: 'Use {steps.draft.last}', output: true },
          ],
        });
      }).not.toThrow();
    });

    test('accepts {steps.x.last} referencing a {transcript}-shared multi-branch step', () => {
      expect(() => {
        return validateReasoningConfig({
          mode: 'pipeline',
          steps: [
            {
              name: 'debate',
              rounds: 2,
              branches: [
                { name: 'A', prompt: 'Argue. {transcript}' },
                { name: 'B', prompt: 'Argue. {transcript}' },
              ],
            },
            {
              name: 'final',
              prompt: 'Use {steps.debate.last}',
              output: true,
            },
          ],
        });
      }).not.toThrow();
    });

    test('rejects an unknown mode', () => {
      expectCode(() => {
        return validateReasoningConfig({ mode: 'reflect' });
      }, 'INVALID_REASONING_CONFIG');
    });

    test('rejects a pipeline with no steps', () => {
      expectCode(() => {
        return validateReasoningConfig({ mode: 'pipeline', steps: [] });
      }, 'INVALID_REASONING_CONFIG');
    });

    test('rejects more than the maximum number of steps', () => {
      const steps = Array.from({ length: 9 }, (_unused, i) => {
        return { name: `s${i}`, prompt: 'p' };
      });
      expectCode(() => {
        return validateReasoningConfig({ mode: 'pipeline', steps });
      }, 'INVALID_REASONING_CONFIG');
    });

    test('rejects duplicate step names', () => {
      expectCode(() => {
        return validateReasoningConfig({
          mode: 'pipeline',
          steps: [
            { name: 'dup', prompt: 'a' },
            { name: 'dup', prompt: 'b' },
          ],
        });
      }, 'INVALID_REASONING_CONFIG');
    });

    test('rejects a dotted step name', () => {
      expectCode(() => {
        return validateReasoningConfig({
          mode: 'pipeline',
          steps: [{ name: 'a.b', prompt: 'p' }],
        });
      }, 'INVALID_REASONING_CONFIG');
    });

    test('rejects a step missing a prompt when no branch supplies one', () => {
      expectCode(() => {
        return validateReasoningConfig({
          mode: 'pipeline',
          steps: [{ name: 'a' }],
        });
      }, 'INVALID_REASONING_CONFIG');
    });

    test('rejects a step missing a prompt when only some branches supply one', () => {
      expectCode(() => {
        return validateReasoningConfig({
          mode: 'pipeline',
          steps: [
            {
              name: 'a',
              branches: [{ name: 'A', prompt: 'p' }, { name: 'B' }],
            },
          ],
        });
      }, 'INVALID_REASONING_CONFIG');
    });

    test('accepts a step with no step-level prompt when every branch has one', () => {
      expect(() => {
        return validateReasoningConfig({
          mode: 'pipeline',
          steps: [
            {
              name: 'a',
              branches: [
                { name: 'A', prompt: 'pa' },
                { name: 'B', prompt: 'pb' },
              ],
              output: true,
            },
          ],
        });
      }).not.toThrow();
    });

    test.each(['kind', 'count', 'perspectives'])(
      'rejects the removed %s field',
      (field) => {
        expectCode(() => {
          return validateReasoningConfig({
            mode: 'pipeline',
            steps: [{ name: 'a', prompt: 'p', [field]: 'x' }],
          });
        }, 'INVALID_REASONING_CONFIG');
      }
    );

    test('rejects branches out of range (0 entries)', () => {
      expectCode(() => {
        return validateReasoningConfig({
          mode: 'pipeline',
          steps: [{ name: 'a', prompt: 'p', branches: [] }],
        });
      }, 'INVALID_REASONING_CONFIG');
    });

    test('rejects branches out of range (too many entries)', () => {
      expectCode(() => {
        return validateReasoningConfig({
          mode: 'pipeline',
          steps: [
            {
              name: 'a',
              prompt: 'p',
              branches: Array.from({ length: 6 }, () => {
                return {};
              }),
            },
          ],
        });
      }, 'INVALID_REASONING_CONFIG');
    });

    test('rejects a branch entry with a non-string field', () => {
      expectCode(() => {
        return validateReasoningConfig({
          mode: 'pipeline',
          steps: [
            {
              name: 'a',
              prompt: 'p',
              branches: [{ name: 'ok' }, { name: 123 }],
            },
          ],
        });
      }, 'INVALID_REASONING_CONFIG');
    });

    test('rejects a branch temperature that is not a number', () => {
      expectCode(() => {
        return validateReasoningConfig({
          mode: 'pipeline',
          steps: [
            {
              name: 'a',
              prompt: 'p',
              branches: [{ name: 'ok', temperature: 'hot' }],
            },
          ],
        });
      }, 'INVALID_REASONING_CONFIG');
    });

    test('rejects haltIfEquals on a multi-branch step', () => {
      expectCode(() => {
        return validateReasoningConfig({
          mode: 'pipeline',
          steps: [
            {
              name: 'a',
              prompt: 'p',
              branches: [{ name: 'A' }, { name: 'B' }],
              haltIfEquals: 'APPROVED',
            },
          ],
        });
      }, 'INVALID_REASONING_CONFIG');
    });

    test('accepts haltIfEquals on a single-branch step', () => {
      expect(() => {
        return validateReasoningConfig({
          mode: 'pipeline',
          steps: [
            { name: 'a', prompt: 'p', haltIfEquals: 'APPROVED' },
            { name: 'final', prompt: 'q', output: true },
          ],
        });
      }).not.toThrow();
    });

    test('rejects rounds out of range', () => {
      expectCode(() => {
        return validateReasoningConfig({
          mode: 'pipeline',
          steps: [{ name: 'a', prompt: 'p', rounds: 9 }],
        });
      }, 'INVALID_REASONING_CONFIG');
    });

    test('rejects rounds > 1 with no {transcript} reference', () => {
      expectCode(() => {
        return validateReasoningConfig({
          mode: 'pipeline',
          steps: [
            {
              name: 'debate',
              rounds: 2,
              branches: [{ name: 'A' }, { name: 'B' }],
              prompt: 'Argue about {question}',
            },
          ],
        });
      }, 'INVALID_REASONING_CONFIG');
    });

    test('rejects a prompt referencing an unknown step', () => {
      expectCode(() => {
        return validateReasoningConfig({
          mode: 'pipeline',
          steps: [
            { name: 'a', prompt: 'p' },
            { name: 'final', prompt: 'Use {steps.typo}', output: true },
          ],
        });
      }, 'INVALID_REASONING_CONFIG');
    });

    test('rejects a prompt referencing a later step', () => {
      expectCode(() => {
        return validateReasoningConfig({
          mode: 'pipeline',
          steps: [
            { name: 'first', prompt: 'Use {steps.second}' },
            { name: 'second', prompt: 'q', output: true },
          ],
        });
      }, 'INVALID_REASONING_CONFIG');
    });

    test('accepts a prompt referencing an earlier step', () => {
      expect(() => {
        return validateReasoningConfig({
          mode: 'pipeline',
          steps: [
            { name: 'first', prompt: 'p' },
            { name: 'second', prompt: 'Use {steps.first}', output: true },
          ],
        });
      }).not.toThrow();
    });

    test('rejects {steps.x.last} referencing an independent multi-branch step', () => {
      expectCode(() => {
        return validateReasoningConfig({
          mode: 'pipeline',
          steps: [
            {
              name: 'samples',
              branches: [{ name: 'A' }, { name: 'B' }],
              prompt: 'Sample {question}',
            },
            {
              name: 'final',
              prompt: 'Use {steps.samples.last}',
              output: true,
            },
          ],
        });
      }, 'INVALID_REASONING_CONFIG');
    });

    test('rejects a pipeline exceeding the total completion budget', () => {
      expectCode(() => {
        return validateReasoningConfig({
          mode: 'pipeline',
          steps: [
            {
              name: 'a',
              prompt: 'p {transcript}',
              rounds: 3,
              branches: Array.from({ length: 5 }, (_unused, i) => {
                return { name: `A${i}` };
              }),
            },
            {
              name: 'b',
              prompt: 'q {transcript}',
              rounds: 2,
              branches: Array.from({ length: 5 }, (_unused, i) => {
                return { name: `B${i}` };
              }),
            },
          ],
        });
      }, 'INVALID_REASONING_CONFIG');
    });
  });
});
