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

  test('returns null for non-provider errors', () => {
    expect(toProviderDomainError(new Error('boom'))).toBeNull();
    expect(toProviderDomainError('boom')).toBeNull();
  });
});
