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

    test('accepts a valid pipeline with a completion and a fanout step', () => {
      expect(() => {
        return validateReasoningConfig({
          mode: 'pipeline',
          steps: [
            {
              kind: 'fanout',
              name: 'angles',
              count: 3,
              prompt: 'a {question}',
            },
            { name: 'final', prompt: 'b {steps.angles}', output: true },
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

    test('rejects a step missing a prompt', () => {
      expectCode(() => {
        return validateReasoningConfig({
          mode: 'pipeline',
          steps: [{ name: 'a' }],
        });
      }, 'INVALID_REASONING_CONFIG');
    });

    test('rejects an unknown step kind', () => {
      expectCode(() => {
        return validateReasoningConfig({
          mode: 'pipeline',
          steps: [{ name: 'a', prompt: 'p', kind: 'loop' }],
        });
      }, 'INVALID_REASONING_CONFIG');
    });

    test('rejects a fanout step with no count or perspectives', () => {
      expectCode(() => {
        return validateReasoningConfig({
          mode: 'pipeline',
          steps: [{ name: 'a', prompt: 'p', kind: 'fanout' }],
        });
      }, 'INVALID_REASONING_CONFIG');
    });

    test('rejects a fanout count out of range', () => {
      expectCode(() => {
        return validateReasoningConfig({
          mode: 'pipeline',
          steps: [{ name: 'a', prompt: 'p', kind: 'fanout', count: 9 }],
        });
      }, 'INVALID_REASONING_CONFIG');
    });
  });
});
