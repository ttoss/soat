import {
  applyReflection,
  buildReasoningProviderOptions,
  resolveReasoningConfig,
} from 'src/lib/reasoning';
import * as reasoningCompletionModule from 'src/lib/reasoningCompletion';

const mockRunReasoningCompletion = jest.spyOn(
  reasoningCompletionModule,
  'runReasoningCompletion'
);

describe('reasoning lib', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('resolveReasoningConfig', () => {
    test('returns the agent config when no override is given', () => {
      expect(
        resolveReasoningConfig({ agentConfig: { mode: 'reflect' } })
      ).toEqual({ mode: 'reflect' });
    });

    test('the per-generate override replaces the agent config entirely', () => {
      expect(
        resolveReasoningConfig({
          agentConfig: { mode: 'reflect', effort: 'high' },
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
        resolveReasoningConfig({ agentConfig: 'reflect' as never })
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

  describe('applyReflection', () => {
    const baseArgs = {
      agentId: 'agent_test01',
      projectIds: [1],
      messages: [{ role: 'user', content: 'What is the capital of France?' }],
      draft: 'The capital of France is Lyon.',
      temperature: null,
    };

    test('runs critique then revision and returns the revised text', async () => {
      mockRunReasoningCompletion
        .mockResolvedValueOnce('The draft names the wrong city; it is Paris.')
        .mockResolvedValueOnce('The capital of France is Paris.');

      const result = await applyReflection({
        ...baseArgs,
        reasoning: { mode: 'reflect' },
      });

      expect(result.applied).toBe(true);
      expect(result.text).toBe('The capital of France is Paris.');
      expect(mockRunReasoningCompletion).toHaveBeenCalledTimes(2);

      const critiqueCall = mockRunReasoningCompletion.mock.calls[0][0];
      expect(critiqueCall.prompt).toContain('What is the capital of France?');
      expect(critiqueCall.prompt).toContain('The capital of France is Lyon.');

      const reviseCall = mockRunReasoningCompletion.mock.calls[1][0];
      expect(reviseCall.prompt).toContain(
        'The draft names the wrong city; it is Paris.'
      );
    });

    test('short-circuits without a revision call when the critique approves', async () => {
      mockRunReasoningCompletion.mockResolvedValueOnce('APPROVED');

      const result = await applyReflection({
        ...baseArgs,
        draft: 'The capital of France is Paris.',
        reasoning: { mode: 'reflect' },
      });

      expect(result.applied).toBe(false);
      expect(result.text).toBe('The capital of France is Paris.');
      expect(mockRunReasoningCompletion).toHaveBeenCalledTimes(1);
    });

    test('routes the critique call through the critique override triple', async () => {
      mockRunReasoningCompletion
        .mockResolvedValueOnce('Needs more precision.')
        .mockResolvedValueOnce('Revised answer.');

      await applyReflection({
        ...baseArgs,
        reasoning: {
          mode: 'reflect',
          critique: {
            aiProviderId: 'aip_cheap01',
            model: 'tiny-critic',
            prompt: 'Critique only factual accuracy.',
          },
        },
      });

      const critiqueCall = mockRunReasoningCompletion.mock.calls[0][0];
      expect(critiqueCall.aiProviderId).toBe('aip_cheap01');
      expect(critiqueCall.model).toBe('tiny-critic');
      // The custom prompt replaces the default critique instructions...
      expect(critiqueCall.prompt).toContain('Critique only factual accuracy.');
      expect(critiqueCall.prompt).not.toContain('weaknesses');
      // ...but the engine-owned scaffolding (question + draft) is kept.
      expect(critiqueCall.prompt).toContain('What is the capital of France?');
      expect(critiqueCall.prompt).toContain('The capital of France is Lyon.');

      // The revision stays on the agent's own model.
      const reviseCall = mockRunReasoningCompletion.mock.calls[1][0];
      expect(reviseCall.aiProviderId).toBeUndefined();
      expect(reviseCall.model).toBeUndefined();
    });

    test('returns the draft when the critique call fails', async () => {
      mockRunReasoningCompletion.mockRejectedValueOnce(
        new Error('provider down')
      );

      const result = await applyReflection({
        ...baseArgs,
        reasoning: { mode: 'reflect' },
      });

      expect(result.applied).toBe(false);
      expect(result.text).toBe(baseArgs.draft);
    });

    test('returns the draft when the revision call fails', async () => {
      mockRunReasoningCompletion
        .mockResolvedValueOnce('The city is wrong.')
        .mockRejectedValueOnce(new Error('provider down'));

      const result = await applyReflection({
        ...baseArgs,
        reasoning: { mode: 'reflect' },
      });

      expect(result.applied).toBe(false);
      expect(result.text).toBe(baseArgs.draft);
    });

    test('does nothing when mode is not reflect', async () => {
      const result = await applyReflection({
        ...baseArgs,
        reasoning: { effort: 'high' },
      });

      expect(result.applied).toBe(false);
      expect(result.text).toBe(baseArgs.draft);
      expect(mockRunReasoningCompletion).not.toHaveBeenCalled();
    });
  });
});
