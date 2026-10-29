import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  anthropicFederatedAccessToken,
  type AnthropicFederationSettings,
  createAnthropicTokenSource,
  readAnthropicFederationSettings,
  requireAnthropicFederationSettings,
  withAnthropicFederatedToken,
} from 'src/lib/anthropicFederation';

const SETTINGS: AnthropicFederationSettings = {
  federationRuleId: 'fdrl_rule',
  organizationId: '00000000-0000-0000-0000-000000000000',
  serviceAccountId: 'svac_account',
  workspaceId: 'wrkspc_workspace',
};

/**
 * The token endpoint is the external boundary these tests fake: each answer is
 * served in order, and every request body is kept for assertions.
 */
const fakeTokenEndpoint = (answers: { status?: number; body: unknown }[]) => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = async (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string }
  ) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const answer = answers[calls.length - 1];
    if (!answer) throw new Error(`unexpected exchange #${calls.length}`);
    const status = answer.status ?? 200;
    return {
      ok: status < 400,
      status,
      text: async () => {
        return JSON.stringify(answer.body);
      },
    };
  };
  return { fetchImpl, calls };
};

const issued = (accessToken: string, expiresIn: number) => {
  return {
    body: {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
    },
  };
};

describe('readAnthropicFederationSettings', () => {
  test('reads the federation the operator configured', () => {
    expect(
      readAnthropicFederationSettings({
        ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_rule',
        ANTHROPIC_ORGANIZATION_ID: 'org',
        ANTHROPIC_SERVICE_ACCOUNT_ID: 'svac_account',
        ANTHROPIC_WORKSPACE_ID: 'wrkspc_workspace',
        ANTHROPIC_IDENTITY_TOKEN_FILE: '/var/run/token',
      })
    ).toEqual({
      federationRuleId: 'fdrl_rule',
      organizationId: 'org',
      serviceAccountId: 'svac_account',
      workspaceId: 'wrkspc_workspace',
      identityTokenFile: '/var/run/token',
    });
  });

  test.each([
    'ANTHROPIC_FEDERATION_RULE_ID',
    'ANTHROPIC_ORGANIZATION_ID',
    'ANTHROPIC_SERVICE_ACCOUNT_ID',
  ])('is unconfigured without %s', (missing) => {
    const env: Record<string, string> = {
      ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_rule',
      ANTHROPIC_ORGANIZATION_ID: 'org',
      ANTHROPIC_SERVICE_ACCOUNT_ID: 'svac_account',
    };
    env[missing] = '';
    expect(readAnthropicFederationSettings(env)).toBeUndefined();
  });

  test('a token is refused on an unconfigured deployment', async () => {
    const previous = process.env.ANTHROPIC_FEDERATION_RULE_ID;
    delete process.env.ANTHROPIC_FEDERATION_RULE_ID;
    try {
      await expect(anthropicFederatedAccessToken()).rejects.toMatchObject({
        code: 'AI_PROVIDER_MISCONFIGURED',
      });
    } finally {
      if (previous !== undefined) {
        process.env.ANTHROPIC_FEDERATION_RULE_ID = previous;
      }
    }
  });

  test('requiring it refuses an unconfigured deployment', () => {
    const previous = process.env.ANTHROPIC_FEDERATION_RULE_ID;
    delete process.env.ANTHROPIC_FEDERATION_RULE_ID;
    try {
      expect(() => {
        return requireAnthropicFederationSettings();
      }).toThrow(
        expect.objectContaining({
          code: 'AI_PROVIDER_MISCONFIGURED',
          message: expect.stringMatching(/ANTHROPIC_FEDERATION_RULE_ID/),
        })
      );
    } finally {
      if (previous !== undefined) {
        process.env.ANTHROPIC_FEDERATION_RULE_ID = previous;
      }
    }
  });
});

describe('createAnthropicTokenSource', () => {
  test('exchanges the identity token with a jwt-bearer grant', async () => {
    const { fetchImpl, calls } = fakeTokenEndpoint([
      issued('sk-ant-oat01-a', 3600),
    ]);
    const token = createAnthropicTokenSource({
      settings: SETTINGS,
      identityToken: async () => {
        return 'aws-signed-jwt';
      },
      fetchImpl,
    });

    await expect(token()).resolves.toBe('sk-ant-oat01-a');
    expect(calls).toEqual([
      {
        url: 'https://api.anthropic.com/v1/oauth/token',
        body: {
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: 'aws-signed-jwt',
          federation_rule_id: 'fdrl_rule',
          organization_id: '00000000-0000-0000-0000-000000000000',
          service_account_id: 'svac_account',
          workspace_id: 'wrkspc_workspace',
        },
      },
    ]);
  });

  test('omits the workspace when none is configured', async () => {
    const { fetchImpl, calls } = fakeTokenEndpoint([issued('t', 3600)]);
    await createAnthropicTokenSource({
      settings: { ...SETTINGS, workspaceId: undefined },
      identityToken: async () => {
        return 'jwt';
      },
      fetchImpl,
    })();
    expect(calls[0].body).not.toHaveProperty('workspace_id');
  });

  test('reuses a token until it nears expiry', async () => {
    const { fetchImpl, calls } = fakeTokenEndpoint([issued('long', 3600)]);
    const token = createAnthropicTokenSource({
      settings: SETTINGS,
      identityToken: async () => {
        return 'jwt';
      },
      fetchImpl,
    });

    await token();
    await expect(token()).resolves.toBe('long');
    expect(calls).toHaveLength(1);
  });

  test('re-exchanges with a fresh identity token once one nears expiry', async () => {
    const { fetchImpl, calls } = fakeTokenEndpoint([
      issued('short', 30),
      issued('next', 3600),
    ]);
    let minted = 0;
    const token = createAnthropicTokenSource({
      settings: SETTINGS,
      identityToken: async () => {
        minted += 1;
        return `jwt-${minted}`;
      },
      fetchImpl,
    });

    await expect(token()).resolves.toBe('short');
    await expect(token()).resolves.toBe('next');
    expect(
      calls.map((call) => {
        return call.body.assertion;
      })
    ).toEqual(['jwt-1', 'jwt-2']);
  });

  test('shares one exchange between concurrent callers', async () => {
    const { fetchImpl, calls } = fakeTokenEndpoint([issued('shared', 3600)]);
    const token = createAnthropicTokenSource({
      settings: SETTINGS,
      identityToken: async () => {
        return 'jwt';
      },
      fetchImpl,
    });

    await expect(Promise.all([token(), token(), token()])).resolves.toEqual([
      'shared',
      'shared',
      'shared',
    ]);
    expect(calls).toHaveLength(1);
  });

  test('a refused exchange is a misconfiguration, and the next call retries', async () => {
    const { fetchImpl, calls } = fakeTokenEndpoint([
      {
        status: 401,
        body: {
          type: 'error',
          error: {
            type: 'authentication_error',
            message: 'Authentication failed',
          },
        },
      },
      issued('recovered', 3600),
    ]);
    const token = createAnthropicTokenSource({
      settings: SETTINGS,
      identityToken: async () => {
        return 'jwt';
      },
      fetchImpl,
    });

    await expect(token()).rejects.toMatchObject({
      code: 'AI_PROVIDER_MISCONFIGURED',
      message: expect.stringMatching(/HTTP 401/),
    });
    await expect(token()).resolves.toBe('recovered');
    expect(calls).toHaveLength(2);
  });

  test.each([{ token_type: 'Bearer' }, 'not json', null])(
    'a success without a usable token is a misconfiguration (%p)',
    async (body) => {
      const { fetchImpl } = fakeTokenEndpoint([{ body }]);
      await expect(
        createAnthropicTokenSource({
          settings: SETTINGS,
          identityToken: async () => {
            return 'jwt';
          },
          fetchImpl,
        })()
      ).rejects.toMatchObject({ code: 'AI_PROVIDER_MISCONFIGURED' });
    }
  );

  test('reads the identity token from the configured file on each exchange', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'anthropic-wif-')), 'token');
    writeFileSync(file, 'projected-1\n');
    const { fetchImpl, calls } = fakeTokenEndpoint([
      issued('a', 30),
      issued('b', 3600),
    ]);
    const token = createAnthropicTokenSource({
      settings: { ...SETTINGS, identityTokenFile: file },
      fetchImpl,
    });

    await token();
    writeFileSync(file, 'projected-2\n');
    await token();
    expect(
      calls.map((call) => {
        return call.body.assertion;
      })
    ).toEqual(['projected-1', 'projected-2']);
  });
});

describe('withAnthropicFederatedToken', () => {
  test('replaces the API key header with the federated Bearer token', async () => {
    const seen: Headers[] = [];
    const wrapped = withAnthropicFederatedToken({
      fetchImpl: async (_input, init) => {
        seen.push(new Headers(init?.headers));
        return new Response('{}');
      },
      accessToken: async () => {
        return 'sk-ant-oat01-current';
      },
    });

    await wrapped('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': '', 'anthropic-version': '2023-06-01' },
    });

    expect(seen[0].get('x-api-key')).toBeNull();
    expect(seen[0].get('authorization')).toBe('Bearer sk-ant-oat01-current');
    expect(seen[0].get('anthropic-version')).toBe('2023-06-01');
  });
});
