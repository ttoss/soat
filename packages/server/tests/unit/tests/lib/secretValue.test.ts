import crypto from 'node:crypto';

import { generateSecretValue } from 'src/lib/secrets';

/**
 * API keys, trigger secrets and webhook secrets are all minted here, and API
 * keys are stored as a plain SHA-256. A fast hash is safe only while the input
 * is unguessable, so the entropy is pinned rather than assumed.
 */
describe('generateSecretValue', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('draws 32 bytes from the CSPRNG', () => {
    const randomBytes = jest.spyOn(crypto, 'randomBytes');

    generateSecretValue();

    expect(randomBytes).toHaveBeenCalledWith(32);
  });

  test('returns them as 64 hex characters', () => {
    expect(generateSecretValue()).toMatch(/^[0-9a-f]{64}$/);
  });

  test('two values differ', () => {
    expect(generateSecretValue()).not.toBe(generateSecretValue());
  });
});
