import { APICallError, RetryError } from 'ai';
import { DomainError } from 'src/errors';
import { toProviderDomainError } from 'src/lib/providerError';

describe('toProviderDomainError', () => {
  const buildApiCallError = () => {
    return new APICallError({
      message: 'insufficient credits',
      url: 'https://api.x.ai/v1/chat/completions',
      requestBodyValues: {},
      statusCode: 402,
      responseBody: '{"error":"insufficient_quota"}',
    });
  };

  test('maps APICallError to a 502 AI_PROVIDER_ERROR DomainError', () => {
    const error = toProviderDomainError(buildApiCallError());

    expect(error).toBeInstanceOf(DomainError);
    expect(error?.code).toBe('AI_PROVIDER_ERROR');
    expect(error?.httpStatus).toBe(502);
    expect(error?.message).toContain('402');
    expect(error?.message).toContain('insufficient credits');
    expect(error?.meta?.providerStatusCode).toBe(402);
  });

  test('unwraps RetryError to the last APICallError', () => {
    const apiCallError = buildApiCallError();
    const retryError = new RetryError({
      message: 'Failed after 3 attempts',
      reason: 'maxRetriesExceeded',
      errors: [apiCallError, apiCallError],
    });

    const error = toProviderDomainError(retryError);

    expect(error?.code).toBe('AI_PROVIDER_ERROR');
    expect(error?.message).toContain('402');
  });

  test('maps APICallError without a status code (network failure)', () => {
    const networkError = new APICallError({
      message: 'Cannot connect to API',
      url: 'http://127.0.0.1:9/v1/chat/completions',
      requestBodyValues: {},
    });

    const error = toProviderDomainError(networkError);

    expect(error?.code).toBe('AI_PROVIDER_ERROR');
    expect(error?.message).toContain('Cannot connect to API');
  });

  test('maps network-level fetch failures', () => {
    const error = toProviderDomainError(new TypeError('fetch failed'));

    expect(error?.code).toBe('AI_PROVIDER_ERROR');
    expect(error?.message).toContain('fetch failed');
  });

  /**
   * A provider that fails *part-way* through a stream sends its fault as a
   * `data: {"error": {...}}` frame, which the AI SDK hands on as the raw JSON
   * value rather than an `APICallError` — nothing threw, the response was
   * already `200`. Before #1084 it fell through to the generic wrapper and the
   * caller was told "Internal Server Error" about a fault the provider had
   * named.
   */
  test('maps a mid-stream provider error frame to its own message', () => {
    // The shape the AI SDK forwards from an OpenAI-compatible `data: {"error":
    // {...}}` frame: the frame's inner value, unwrapped.
    const error = toProviderDomainError({
      message: 'upstream capacity exceeded',
      type: 'server_error',
      code: 'overloaded',
    });

    expect(error?.code).toBe('AI_PROVIDER_ERROR');
    expect(error?.httpStatus).toBe(502);
    expect(error?.message).toContain('upstream capacity exceeded');
  });

  test('maps a mid-stream error frame that arrives still wrapped', () => {
    const error = toProviderDomainError({
      error: { message: 'model overloaded' },
    });

    expect(error?.code).toBe('AI_PROVIDER_ERROR');
    expect(error?.message).toContain('model overloaded');
  });

  test('returns null for non-provider errors', () => {
    expect(toProviderDomainError(new Error('boom'))).toBeNull();
    expect(toProviderDomainError('boom')).toBeNull();
    // No string `message` anywhere: not a provider frame.
    expect(toProviderDomainError({ error: 'nope' })).toBeNull();
    expect(toProviderDomainError({ error: { code: 500 } })).toBeNull();
    expect(toProviderDomainError({ status: 500 })).toBeNull();
  });
});
