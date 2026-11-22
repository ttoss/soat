import { loadBootConfig } from '../../../../src/lib/bootConfig';

/**
 * No request reaches boot, so the settings it validates are driven through
 * `loadBootConfig` itself: each one malformed must fail it, not the first call
 * that reads it.
 */
const SETTINGS = [
  { env: 'SOAT_RESERVED_TOOL_CONTEXT_PREFIX', valid: 'plat_' },
  { env: 'SOAT_HEADER_PREFIX', valid: 'X-Acme-' },
  { env: 'EMBEDDING_INPUT_1M_TOKEN_PRICE_USD', valid: '0.02' },
];

describe('loadBootConfig', () => {
  const original = Object.fromEntries(
    SETTINGS.map(({ env }) => {
      return [env, process.env[env]];
    })
  );

  afterEach(() => {
    for (const [env, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[env];
      } else {
        process.env[env] = value;
      }
    }
  });

  test('passes with every setting well-formed', () => {
    for (const { env, valid } of SETTINGS) {
      process.env[env] = valid;
    }
    expect(() => {
      return loadBootConfig();
    }).not.toThrow();
  });

  test.each(SETTINGS)('a malformed $env fails boot, naming it', ({ env }) => {
    process.env[env] = 'not valid';
    expect(() => {
      return loadBootConfig();
    }).toThrow(env);
  });
});
