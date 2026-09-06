import {
  EMBEDDING_INPUT_1M_TOKEN_PRICE_ENV,
  embeddingPriceWarning,
  parseEmbeddingInputTokenPriceUsd,
  readEmbeddingInputTokenPriceUsd,
} from 'src/lib/embeddingPrice';

// The embedding stack is deployment configuration rather than an AiProvider
// row, so its rate is configuration too. These pin the unit conversion (the
// variable is per *million* tokens, the meter is per token) and the fail-closed
// parse — a rate this module accepts is frozen onto every embedding event.
describe('parseEmbeddingInputTokenPriceUsd', () => {
  test('converts USD per million tokens to USD per token', () => {
    expect(parseEmbeddingInputTokenPriceUsd({ value: '0.02' })).toBe(
      '0.00000002'
    );
  });

  test('keeps the conversion exact rather than going through a float', () => {
    // 0.07 / 1e6 is 6.999999999999999e-8 in binary floating point. The shift is
    // decimal, so the rate an operator wrote is the rate that gets frozen.
    expect(parseEmbeddingInputTokenPriceUsd({ value: '0.07' })).toBe(
      '0.00000007'
    );
    expect(parseEmbeddingInputTokenPriceUsd({ value: '0.13' })).toBe(
      '0.00000013'
    );
  });

  test('an integer rate needs no decimal point to shift', () => {
    expect(parseEmbeddingInputTokenPriceUsd({ value: '2' })).toBe('0.000002');
  });

  test('unset is zero — the deployment states no rate, so nothing is charged', () => {
    expect(parseEmbeddingInputTokenPriceUsd({ value: undefined })).toBe('0');
    expect(parseEmbeddingInputTokenPriceUsd({ value: '' })).toBe('0');
    expect(parseEmbeddingInputTokenPriceUsd({ value: '   ' })).toBe('0');
  });

  test('an explicit zero is a rate, and reads the same as unset', () => {
    expect(parseEmbeddingInputTokenPriceUsd({ value: '0' })).toBe('0');
  });

  test('surrounding whitespace is tolerated', () => {
    expect(parseEmbeddingInputTokenPriceUsd({ value: ' 0.02 ' })).toBe(
      '0.00000002'
    );
  });

  test.each([
    ['negative', '-0.02'],
    ['non-numeric', 'free'],
    ['scientific notation', '2e-2'],
    ['a currency symbol', '$0.02'],
    ['a thousands separator', '0,02'],
    ['a trailing unit', '0.02/1M'],
  ])('rejects %s rather than guessing', (_label, value) => {
    expect(() => {
      return parseEmbeddingInputTokenPriceUsd({ value });
    }).toThrow(EMBEDDING_INPUT_1M_TOKEN_PRICE_ENV);
  });
});

describe('readEmbeddingInputTokenPriceUsd', () => {
  const original = process.env[EMBEDDING_INPUT_1M_TOKEN_PRICE_ENV];

  afterEach(() => {
    if (original === undefined) {
      delete process.env[EMBEDDING_INPUT_1M_TOKEN_PRICE_ENV];
    } else {
      process.env[EMBEDDING_INPUT_1M_TOKEN_PRICE_ENV] = original;
    }
  });

  test('reads the deployment variable', () => {
    process.env[EMBEDDING_INPUT_1M_TOKEN_PRICE_ENV] = '0.02';
    expect(readEmbeddingInputTokenPriceUsd()).toBe('0.00000002');
  });

  test('an invalid value throws, so a bad rate fails boot rather than a call', () => {
    process.env[EMBEDDING_INPUT_1M_TOKEN_PRICE_ENV] = 'nope';
    expect(() => {
      return readEmbeddingInputTokenPriceUsd();
    }).toThrow(EMBEDDING_INPUT_1M_TOKEN_PRICE_ENV);
  });
});

describe('embeddingPriceWarning', () => {
  test('warns when a vendor-billed provider states no rate', () => {
    const warning = embeddingPriceWarning({
      provider: 'bedrock',
      value: undefined,
    });
    expect(warning).toContain(EMBEDDING_INPUT_1M_TOKEN_PRICE_ENV);
    expect(warning).toContain('bedrock');
  });

  test('stays silent once a rate is stated, zero included', () => {
    expect(
      embeddingPriceWarning({ provider: 'bedrock', value: '0.02' })
    ).toBeNull();
    expect(
      embeddingPriceWarning({ provider: 'bedrock', value: '0' })
    ).toBeNull();
  });

  test('stays silent for a local model, which bills nothing per token', () => {
    expect(
      embeddingPriceWarning({ provider: 'ollama', value: undefined })
    ).toBeNull();
  });

  test('stays silent when no embedding provider is configured at all', () => {
    expect(
      embeddingPriceWarning({ provider: undefined, value: undefined })
    ).toBeNull();
  });

  test('treats a blank rate as unset', () => {
    expect(
      embeddingPriceWarning({ provider: 'openai', value: '  ' })
    ).not.toBeNull();
  });
});
