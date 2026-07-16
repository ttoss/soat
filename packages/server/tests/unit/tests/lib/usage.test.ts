import { extractUsageTokens } from 'src/lib/usage';

/**
 * Pure mapping from the AI SDK `LanguageModelUsage` to the meter's token
 * columns. Covers the branches that are awkward to drive through a real
 * provider over HTTP: usage entirely absent, and a provider that reports
 * totals but omits the cached/reasoning breakdown (must record 0, not null).
 */
describe('extractUsageTokens', () => {
  test('maps input, output, cached, and reasoning tokens', () => {
    expect(
      extractUsageTokens({
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        inputTokenDetails: {
          noCacheTokens: 6,
          cacheReadTokens: 4,
          cacheWriteTokens: 0,
        },
        outputTokenDetails: { textTokens: 13, reasoningTokens: 7 },
      })
    ).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cachedTokens: 4,
      reasoningTokens: 7,
    });
  });

  test('defaults every field to 0 when usage is undefined', () => {
    expect(extractUsageTokens(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
    });
  });

  test('records 0 cached/reasoning when the provider omits the breakdown', () => {
    expect(
      extractUsageTokens({
        inputTokens: 5,
        outputTokens: 8,
        totalTokens: 13,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: undefined,
        },
      })
    ).toEqual({
      inputTokens: 5,
      outputTokens: 8,
      cachedTokens: 0,
      reasoningTokens: 0,
    });
  });

  test('records 0 for every count when the provider omits input/output totals', () => {
    expect(
      extractUsageTokens({
        inputTokens: undefined,
        outputTokens: undefined,
        totalTokens: undefined,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: undefined,
        },
      })
    ).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
    });
  });
});
