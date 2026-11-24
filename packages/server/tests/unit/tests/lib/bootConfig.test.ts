import {
  loadBootConfig,
  loadBootConfigOrExit,
} from '../../../../src/lib/bootConfig';

/**
 * No request reaches boot, so the settings it validates are driven through
 * `loadBootConfig` itself: each one malformed must fail it, not the first call
 * that reads it.
 */
const SETTINGS = [
  { env: 'SOAT_RESERVED_TOOL_CONTEXT_PREFIX', valid: 'plat_' },
  { env: 'SOAT_HEADER_PREFIX', valid: 'X-Acme-' },
  { env: 'EMBEDDING_INPUT_1M_TOKEN_PRICE_USD', valid: '0.02' },
  { env: 'SECRETS_ENCRYPTION_KEY', valid: 'ab'.repeat(32) },
  {
    env: 'FILES_UPLOAD_URL_TEMPLATE',
    valid:
      'https://gateway.example.com/v1/projects/{project_id}/files/upload/{token}',
  },
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

  test.each([
    ['unset', undefined],
    ['64 hex characters and trailing junk', `${'ab'.repeat(32)}zz`],
  ])('a SECRETS_ENCRYPTION_KEY %s fails boot, naming it', (_, value) => {
    if (value === undefined) {
      delete process.env.SECRETS_ENCRYPTION_KEY;
    } else {
      process.env.SECRETS_ENCRYPTION_KEY = value;
    }
    expect(() => {
      return loadBootConfig();
    }).toThrow('SECRETS_ENCRYPTION_KEY');
  });
});

/**
 * `process.exit` would end the test worker, so it throws instead.
 */
const stubProcessExit = () => {
  return jest.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`process.exit(${String(code)})`);
  });
};

describe('loadBootConfigOrExit', () => {
  const ENVS = [
    'SOAT_RESERVED_TOOL_CONTEXT_PREFIX',
    'EMBEDDING_PROVIDER',
    'EMBEDDING_INPUT_1M_TOKEN_PRICE_USD',
  ];
  const original = Object.fromEntries(
    ENVS.map((env) => {
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
    jest.restoreAllMocks();
  });

  test('exits 1 on a malformed setting, printing why', () => {
    process.env.SOAT_RESERVED_TOOL_CONTEXT_PREFIX = 'not valid';
    const exit = stubProcessExit();
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(loadBootConfigOrExit).toThrow('process.exit(1)');
    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('SOAT_RESERVED_TOOL_CONTEXT_PREFIX')
    );
  });

  test('warns when a priced provider has no embedding price', () => {
    process.env.EMBEDDING_PROVIDER = 'openai';
    delete process.env.EMBEDDING_INPUT_1M_TOKEN_PRICE_USD;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    loadBootConfigOrExit();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('EMBEDDING_INPUT_1M_TOKEN_PRICE_USD')
    );
  });

  test('stays silent with every setting in place', () => {
    process.env.EMBEDDING_PROVIDER = 'ollama';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const exit = stubProcessExit();

    loadBootConfigOrExit();

    expect(warn).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
