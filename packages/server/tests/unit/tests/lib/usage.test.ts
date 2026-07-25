import { db } from 'src/db';
import { extractUsageTokens, recordCompletionUsage } from 'src/lib/usage';

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

describe('recordCompletionUsage', () => {
  // Metering is an observability side effect: it must never surface as a
  // failure of the completion it measures. The swallow branch is driven for
  // real — a project id with no row behind it makes the event insert violate
  // its foreign key — rather than with a stubbed rejection.
  test('swallows a write failure instead of throwing', async () => {
    const before = await db.UsageEvent.count();

    await expect(
      recordCompletionUsage({
        source: 'chat',
        projectId: 2_147_483_600, // no Project row → FK violation on insert
        provider: 'ollama',
        aiProviderId: null,
        model: 'stub-model',
        usage: {
          inputTokens: 5,
          outputTokens: 3,
          totalTokens: 8,
          inputTokenDetails: {
            noCacheTokens: 5,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          outputTokenDetails: { textTokens: 3, reasoningTokens: 0 },
        },
      })
    ).resolves.toBeUndefined();

    // Nothing was written, and no threshold evaluation ran off a phantom event.
    expect(await db.UsageEvent.count()).toBe(before);
  });
});
