import {
  HttpToolError,
  isSoatActionAllowedByBoundary,
  parseHttpExecuteConfig,
  resolveBodyParamInterpolations,
  resolveUrlPathParams,
} from 'src/lib/agentToolResolver';
import { resolveSoatTools } from 'src/lib/agentToolResolverExternalTools';
import { buildSoatRequestBody } from 'src/lib/agentToolResolverSoatBody';
import { withCallTimeout } from 'src/lib/inProcessApi';
import { soatTools } from 'src/lib/soatTools';
import {
  assertValidToolContextKeys,
  buildContextHeaders,
} from 'src/lib/toolContext';

// Pure helpers of the tool resolver, each a table of inputs read through its
// return value. What a resolved tool offers and sends is pinned at the entry
// points: `rest/agentToolResolution.test.ts`, `rest/agentExternalTools.test.ts`
// and `rest/toolHttpDispatch.test.ts`.

describe('HttpToolError', () => {
  test('serializes to JSON with message, name, status, url, method, and body', () => {
    const error = new HttpToolError(
      'HTTP 401 GET https://api.example.com/items: Unauthorized',
      401,
      'Unauthorized',
      'https://api.example.com/items',
      'GET'
    );
    const json = JSON.stringify(error);
    expect(json).not.toBe('{}');
    const parsed = JSON.parse(json) as {
      message: string;
      name: string;
      status: number;
      body: string;
      url: string;
      method: string;
    };
    expect(parsed.message).toContain('HTTP 401');
    expect(parsed.name).toBe('HttpToolError');
    expect(parsed.status).toBe(401);
    expect(parsed.body).toBe('Unauthorized');
    expect(parsed.url).toBe('https://api.example.com/items');
    expect(parsed.method).toBe('GET');
  });

  test('is an instance of Error', () => {
    const error = new HttpToolError(
      'HTTP 500 POST https://api.example.com/items: Internal Server Error',
      500,
      'Internal Server Error',
      'https://api.example.com/items',
      'POST'
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('HttpToolError');
  });
});

describe('buildContextHeaders', () => {
  test('returns empty object when toolContext is undefined', () => {
    expect(buildContextHeaders({ toolContext: undefined })).toEqual({});
  });

  test('returns empty object for an empty args object', () => {
    expect(buildContextHeaders({})).toEqual({});
  });

  test('prefixes toolContext keys with X-Soat-Context- and nothing else', () => {
    const result = buildContextHeaders({
      toolContext: {
        environment: 'production',
        tenantId: 'abc-123',
      },
    });

    expect(result).toEqual({
      'X-Soat-Context-environment': 'production',
      'X-Soat-Context-tenantId': 'abc-123',
    });
  });

  test('preserves header values unchanged', () => {
    const result = buildContextHeaders({
      toolContext: { region: 'us-east-1' },
    });

    expect(result['X-Soat-Context-region']).toBe('us-east-1');
  });

  test('handles multiple context entries', () => {
    const result = buildContextHeaders({
      toolContext: {
        a: '1',
        b: '2',
        c: '3',
      },
    });

    expect(Object.keys(result)).toHaveLength(3);
    expect(result['X-Soat-Context-a']).toBe('1');
    expect(result['X-Soat-Context-b']).toBe('2');
    expect(result['X-Soat-Context-c']).toBe('3');
  });

  // `contextKeys` is the per-tool allowlist. `undefined`/`null`
  // means "forward all", which is what every tool created before it existed has.
  test('forwards everything when contextKeys is null or undefined', () => {
    const toolContext = { a: '1', b: '2' };

    expect(buildContextHeaders({ toolContext, contextKeys: null })).toEqual({
      'X-Soat-Context-a': '1',
      'X-Soat-Context-b': '2',
    });
    expect(
      buildContextHeaders({ toolContext, contextKeys: undefined })
    ).toEqual({
      'X-Soat-Context-a': '1',
      'X-Soat-Context-b': '2',
    });
  });

  test('forwards only listed keys when contextKeys is set', () => {
    expect(
      buildContextHeaders({
        toolContext: { a: '1', b: '2', c: '3' },
        contextKeys: ['a', 'c'],
      })
    ).toEqual({
      'X-Soat-Context-a': '1',
      'X-Soat-Context-c': '3',
    });
  });

  test('an empty contextKeys list forwards nothing', () => {
    expect(
      buildContextHeaders({
        toolContext: { a: '1', b: '2' },
        contextKeys: [],
      })
    ).toEqual({});
  });

  // Header names are case-insensitive, so an allowlist entry matches regardless
  // of case — otherwise the same header could be both allowed and denied
  // depending on how it was typed.
  test('matches allowlist entries case-insensitively', () => {
    expect(
      buildContextHeaders({
        toolContext: { ocaToken: 'tok', tenant: 'acme' },
        contextKeys: ['OCATOKEN'],
      })
    ).toEqual({ 'X-Soat-Context-ocaToken': 'tok' });
  });

  test('a listed key that the bag does not carry adds no header', () => {
    expect(
      buildContextHeaders({
        toolContext: { a: '1' },
        contextKeys: ['a', 'absent'],
      })
    ).toEqual({ 'X-Soat-Context-a': '1' });
  });

  test('always forwards the server-pinned identity keys', () => {
    expect(
      buildContextHeaders({
        toolContext: {
          session_id: 'ses_1',
          actor_id: 'act_1',
          actor_external_id: 'ext_1',
          ocaToken: 'tok',
        },
        contextKeys: [],
      })
    ).toEqual({
      'X-Soat-Context-session_id': 'ses_1',
      'X-Soat-Context-actor_id': 'act_1',
      'X-Soat-Context-actor_external_id': 'ext_1',
    });
  });

  // The key is caller-owned and reaches the header name untouched: no
  // separator collapsing, no re-casing of any character — including the
  // first. Pinned as the whole contract, because every case-transform
  // incident in this project started with a transform this small.
  test('uses the key verbatim, transforming no character', () => {
    expect(
      buildContextHeaders({
        toolContext: {
          tenant_external_id: 'snake',
          'tenant-external-id': 'kebab',
          tenantExternalId: 'camel',
          TenantExternalId: 'pascal',
          'tenant.external.id': 'dotted',
        },
      })
    ).toEqual({
      'X-Soat-Context-tenant_external_id': 'snake',
      'X-Soat-Context-tenant-external-id': 'kebab',
      'X-Soat-Context-tenantExternalId': 'camel',
      'X-Soat-Context-TenantExternalId': 'pascal',
      'X-Soat-Context-tenant.external.id': 'dotted',
    });
  });

  // The header name is exactly `X-Soat-Context-` + the key, so a caller can
  // compute it with string concatenation and no knowledge of any rule.
  test.each([
    ['userId', 'X-Soat-Context-userId'],
    ['user_id', 'X-Soat-Context-user_id'],
    ['env', 'X-Soat-Context-env'],
    ['ENV', 'X-Soat-Context-ENV'],
    ['session_id', 'X-Soat-Context-session_id'],
  ])('key %s maps to %s', (key, header) => {
    expect(buildContextHeaders({ toolContext: { [key]: 'v' } })).toEqual({
      [header]: 'v',
    });
  });
});

describe('assertValidToolContextKeys', () => {
  test('accepts undefined and null', () => {
    expect(() => {
      return assertValidToolContextKeys(undefined);
    }).not.toThrow();
    expect(() => {
      return assertValidToolContextKeys(null);
    }).not.toThrow();
  });

  test('accepts an empty object', () => {
    expect(() => {
      return assertValidToolContextKeys({});
    }).not.toThrow();
  });

  test('accepts the keys the session path auto-populates', () => {
    expect(() => {
      return assertValidToolContextKeys({
        session_id: 'ses_01',
        actor_id: 'actor_01',
        actor_external_id: '+5511999999999',
      });
    }).not.toThrow();
  });

  // Every key shape that survives the header-name grammar keeps working —
  // validation must reject only what would break at call time, never narrow
  // what callers can already send.
  test('accepts snake_case, kebab-case and dotted keys', () => {
    expect(() => {
      return assertValidToolContextKeys({
        tenant_external_id: 'a',
        'tenant-external-id': 'b',
        'actor.external.id': 'c',
        "weird!#$%&'*+^_`|~1": 'd',
      });
    }).not.toThrow();
  });

  test('rejects a key containing a space', () => {
    expect(() => {
      return assertValidToolContextKeys({ 'bad key': 'x' });
    }).toThrow(
      expect.objectContaining({
        code: 'INVALID_TOOL_CONTEXT_KEY',
        httpStatus: 400,
      })
    );
  });

  test.each([
    ['colon', 'bad:key'],
    ['parenthesis', 'bad(key)'],
    ['non-ASCII', 'usuário'],
    ['newline', 'bad\nkey'],
    ['empty', ''],
  ])('rejects a key containing %s', (_label, key) => {
    expect(() => {
      return assertValidToolContextKeys({ [key]: 'x' });
    }).toThrow(expect.objectContaining({ code: 'INVALID_TOOL_CONTEXT_KEY' }));
  });

  test('reports every offending key in the error meta', () => {
    try {
      assertValidToolContextKeys({ 'bad key': '1', 'worse:key': '2', ok: '3' });
      throw new Error('expected assertValidToolContextKeys to throw');
    } catch (error) {
      const meta = (error as { meta?: { keys?: string[] } }).meta;
      expect(meta?.keys).toEqual(['bad key', 'worse:key']);
    }
  });

  // HTTP header names are case-insensitive, so two keys differing only in the
  // casing of a later character collapse into one outbound header and the last
  // one silently wins. Reject instead of dropping a value.
  test('rejects two keys that collide into the same header name', () => {
    expect(() => {
      return assertValidToolContextKeys({ userId: '1', userID: '2' });
    }).toThrow(
      expect.objectContaining({
        code: 'INVALID_TOOL_CONTEXT_KEY',
        httpStatus: 400,
      })
    );
  });

  // Keys are forwarded verbatim, so these two produce *different* header
  // strings — but HTTP folds them onto the same field, so the collision is
  // still real and must still be rejected rather than dropping a value.
  test('rejects two keys differing only in the first character casing', () => {
    expect(() => {
      return assertValidToolContextKeys({ userId: '1', UserId: '2' });
    }).toThrow(expect.objectContaining({ code: 'INVALID_TOOL_CONTEXT_KEY' }));
  });

  test('names the colliding header in the collision error', () => {
    try {
      assertValidToolContextKeys({ tenantId: '1', TenantId: '2' });
      throw new Error('expected assertValidToolContextKeys to throw');
    } catch (error) {
      const err = error as { message?: string; meta?: Record<string, unknown> };
      expect(err.message).toMatch(/X-Soat-Context-TenantId/);
      expect(err.meta?.header).toBe('X-Soat-Context-TenantId');
      expect(err.meta?.keys).toEqual(['tenantId', 'TenantId']);
    }
  });

  // Guards the contract the validator exists to protect: anything it accepts
  // must survive `new Headers()`, which is what fails at call time today.
  test('every accepted key produces a constructible Headers object', () => {
    const context = {
      session_id: 'ses_01',
      tenant_external_id: 'a',
      'tenant-external-id': 'b',
      'actor.external.id': 'c',
    };
    assertValidToolContextKeys(context);
    expect(() => {
      return new Headers(buildContextHeaders({ toolContext: context }));
    }).not.toThrow();
  });
});

describe('isSoatActionAllowedByBoundary', () => {
  test('returns true when boundaryPolicy is null', () => {
    const result = isSoatActionAllowedByBoundary({
      boundaryPolicy: null,
      iamAction: 'agents:CreateGeneration',
    });

    expect(result).toBe(true);
  });

  test('returns true when boundaryPolicy is undefined', () => {
    const result = isSoatActionAllowedByBoundary({
      boundaryPolicy: undefined,
      iamAction: 'agents:CreateGeneration',
    });

    expect(result).toBe(true);
  });

  test('returns false when boundary policy is structurally invalid', () => {
    const result = isSoatActionAllowedByBoundary({
      boundaryPolicy: { invalid: 'policy', notAStatement: true },
      iamAction: 'agents:CreateGeneration',
    });

    expect(result).toBe(false);
  });

  test('returns true when valid Allow policy permits the action', () => {
    const policy = {
      statement: [
        {
          effect: 'Allow',
          action: ['agents:CreateGeneration'],
        },
      ],
    };

    const result = isSoatActionAllowedByBoundary({
      boundaryPolicy: policy,
      iamAction: 'agents:CreateGeneration',
    });

    expect(result).toBe(true);
  });

  test('returns false when valid policy does not allow the action', () => {
    const policy = {
      statement: [
        {
          effect: 'Allow',
          action: ['files:GetFile'],
        },
      ],
    };

    const result = isSoatActionAllowedByBoundary({
      boundaryPolicy: policy,
      iamAction: 'agents:CreateGeneration',
    });

    expect(result).toBe(false);
  });

  test('evaluates a resource-scoped statement against the passed SRN', () => {
    const policy = {
      statement: [
        {
          effect: 'Allow',
          action: ['memories:CreateMemory'],
          resource: ['srn:proj_abc:memory_store:mstore_support'],
        },
      ],
    };

    expect(
      isSoatActionAllowedByBoundary({
        boundaryPolicy: policy,
        iamAction: 'memories:CreateMemory',
        resource: 'srn:proj_abc:memory_store:mstore_support',
      })
    ).toBe(true);

    expect(
      isSoatActionAllowedByBoundary({
        boundaryPolicy: policy,
        iamAction: 'memories:CreateMemory',
        resource: 'srn:proj_abc:memory_store:mstore_other',
      })
    ).toBe(false);
  });

  test('evaluates statement conditions against the passed context', () => {
    const policy = {
      statement: [
        {
          effect: 'Allow',
          action: ['memories:CreateMemory'],
          resource: ['*'],
          condition: { StringEquals: { 'soat:ResourceTag/env': 'prod' } },
        },
      ],
    };

    expect(
      isSoatActionAllowedByBoundary({
        boundaryPolicy: policy,
        iamAction: 'memories:CreateMemory',
        context: { 'soat:ResourceTag/env': 'prod' },
      })
    ).toBe(true);

    expect(
      isSoatActionAllowedByBoundary({
        boundaryPolicy: policy,
        iamAction: 'memories:CreateMemory',
        context: { 'soat:ResourceTag/env': 'staging' },
      })
    ).toBe(false);
  });

  test('falls back to the resource-less shape when no resource is passed', () => {
    const policy = {
      statement: [
        {
          effect: 'Allow',
          action: ['memories:CreateMemory'],
          resource: ['*'],
        },
      ],
    };

    expect(
      isSoatActionAllowedByBoundary({
        boundaryPolicy: policy,
        iamAction: 'memories:CreateMemory',
      })
    ).toBe(true);
  });

  test('returns true when wildcard action allows everything', () => {
    const policy = {
      statement: [
        {
          effect: 'Allow',
          action: ['*'],
        },
      ],
    };

    const result = isSoatActionAllowedByBoundary({
      boundaryPolicy: policy,
      iamAction: 'agents:CreateGeneration',
    });

    expect(result).toBe(true);
  });
});

describe('resolveUrlPathParams', () => {
  test('returns unchanged url and all args as remaining when no placeholders', () => {
    const result = resolveUrlPathParams({
      url: 'https://example.com/api/items',
      toolArgs: { foo: 'bar', baz: 123 },
    });
    expect(result.resolvedUrl).toBe('https://example.com/api/items');
    expect(result.remainingArgs).toEqual({ foo: 'bar', baz: 123 });
  });

  test('replaces single path param and removes it from remainingArgs', () => {
    const result = resolveUrlPathParams({
      url: 'https://example.com/api/items/{itemId}',
      toolArgs: { itemId: 'item-123', filter: 'active' },
    });
    expect(result.resolvedUrl).toBe('https://example.com/api/items/item-123');
    expect(result.remainingArgs).toEqual({ filter: 'active' });
  });

  test('replaces multiple path params', () => {
    const result = resolveUrlPathParams({
      url: 'https://example.com/api/{projectId}/items/{itemId}',
      toolArgs: { projectId: 'prj-1', itemId: 'item-2', extra: 'value' },
    });
    expect(result.resolvedUrl).toBe(
      'https://example.com/api/prj-1/items/item-2'
    );
    expect(result.remainingArgs).toEqual({ extra: 'value' });
  });

  test('URL-encodes path param values', () => {
    const result = resolveUrlPathParams({
      url: 'https://example.com/search/{query}',
      toolArgs: { query: 'hello world' },
    });
    expect(result.resolvedUrl).toBe('https://example.com/search/hello%20world');
  });

  test('leaves placeholder unchanged when arg is not provided', () => {
    const result = resolveUrlPathParams({
      url: 'https://example.com/{id}/details',
      toolArgs: { other: 'value' },
    });
    expect(result.resolvedUrl).toBe('https://example.com/{id}/details');
    expect(result.remainingArgs).toEqual({ other: 'value' });
  });

  test('handles empty toolArgs', () => {
    const result = resolveUrlPathParams({
      url: 'https://example.com/{id}/details',
      toolArgs: {},
    });
    expect(result.resolvedUrl).toBe('https://example.com/{id}/details');
    expect(result.remainingArgs).toEqual({});
  });
});

describe('parseHttpExecuteConfig', () => {
  test('returns null when execute is null (parsedExecute not a plain object)', () => {
    expect(parseHttpExecuteConfig(null)).toBeNull();
  });

  test('returns null when url is not a string', () => {
    expect(parseHttpExecuteConfig({ url: 123 } as never)).toBeNull();
  });

  test('returns null when url is an empty string', () => {
    expect(parseHttpExecuteConfig({ url: '' } as never)).toBeNull();
  });

  test('returns HttpExecuteConfig when execute has a valid url string', () => {
    const result = parseHttpExecuteConfig({ url: 'https://example.com/api' });
    expect(result).toMatchObject({ url: 'https://example.com/api' });
  });
});

describe('resolveBodyParamInterpolations', () => {
  test('replaces ${body.field} with toolArg value and removes it from remainingArgs', () => {
    const result = resolveBodyParamInterpolations({
      url: 'https://example.com/api/items/${body.itemId}',
      toolArgs: { itemId: 'abc-123', other: 'value' },
    });
    expect(result.resolvedUrl).toBe('https://example.com/api/items/abc-123');
    expect(result.remainingArgs).toEqual({ other: 'value' });
  });

  test('replaces multiple ${body.xxx} placeholders', () => {
    const result = resolveBodyParamInterpolations({
      url: 'https://example.com/${body.projectId}/items/${body.itemId}',
      toolArgs: { projectId: 'prj-1', itemId: 'itm-2', extra: 'x' },
    });
    expect(result.resolvedUrl).toBe('https://example.com/prj-1/items/itm-2');
    expect(result.remainingArgs).toEqual({ extra: 'x' });
  });

  test('URL-encodes body param values', () => {
    const result = resolveBodyParamInterpolations({
      url: 'https://example.com/search/${body.query}',
      toolArgs: { query: 'hello world' },
    });
    expect(result.resolvedUrl).toBe('https://example.com/search/hello%20world');
    expect(result.remainingArgs).toEqual({});
  });

  test('leaves placeholder unchanged when arg not provided', () => {
    const result = resolveBodyParamInterpolations({
      url: 'https://example.com/items/${body.id}',
      toolArgs: { other: 'value' },
    });
    expect(result.resolvedUrl).toBe('https://example.com/items/${body.id}');
    expect(result.remainingArgs).toEqual({ other: 'value' });
  });
});

const soatDef = (name: string) => {
  const def = soatTools.find((t) => {
    return t.name === name;
  });
  expect(def).toBeDefined();
  return def!;
};

describe('withCallTimeout', () => {
  test('returns the value when the call settles inside the budget', async () => {
    await expect(
      withCallTimeout({
        promise: Promise.resolve('done'),
        ms: 60_000,
        label: 'test action',
      })
    ).resolves.toBe('done');
  });

  test('rejects when the call does not settle, naming the action', async () => {
    // A promise that can never settle, so the timer wins without racing the
    // clock against real work.
    await expect(
      withCallTimeout({
        promise: new Promise<never>(() => {}),
        ms: 5,
        label: "SOAT action 'list-tools'",
      })
    ).rejects.toThrow(/SOAT action 'list-tools' timed out after 5ms/);
  });
});

describe('buildSoatRequestBody - trace field injection scoping', () => {
  test('does not inject parent_trace_id/root_trace_id/max_call_depth for actions whose schema does not declare them', () => {
    const body = buildSoatRequestBody({
      def: soatDef('search-knowledge'),
      rawArgs: { query: 'hello' },
      traceId: 'trc_123',
      rootTraceId: 'trc_root',
      remainingDepth: 3,
    });

    expect(body).not.toHaveProperty('parent_trace_id');
    expect(body).not.toHaveProperty('root_trace_id');
    expect(body).not.toHaveProperty('max_call_depth');
  });

  test('still injects parent_trace_id/root_trace_id/max_call_depth for create-agent-generation', () => {
    const body = buildSoatRequestBody({
      def: soatDef('create-agent-generation'),
      rawArgs: { agent_id: 'agt_1', messages: [] },
      toolContext: { env: 'test' },
      traceId: 'trc_123',
      rootTraceId: 'trc_root',
      remainingDepth: 3,
    });

    expect(body).toMatchObject({
      tool_context: { env: 'test' },
      parent_trace_id: 'trc_123',
      root_trace_id: 'trc_root',
      max_call_depth: 2,
    });
  });

  test('roots the lineage at the current trace when no root was carried in', () => {
    const body = buildSoatRequestBody({
      def: soatDef('create-agent-generation'),
      rawArgs: { agent_id: 'agt_1', messages: [] },
      traceId: 'trc_123',
      rootTraceId: null,
      remainingDepth: 3,
    });

    expect(body).toMatchObject({
      parent_trace_id: 'trc_123',
      root_trace_id: 'trc_123',
    });
  });

  // This body is how a `soat` tool hands the bag to whatever it
  // starts, so the tool's allowlist has to bound it here too — otherwise a
  // credential excluded from the tool's own headers still reaches every tool of
  // the nested generation.
  test('filters the propagated tool_context through the tool context_keys', () => {
    const body = buildSoatRequestBody({
      def: soatDef('create-agent-generation'),
      rawArgs: { agent_id: 'agt_1', messages: [] },
      toolContext: { env: 'test', ocaToken: 'tok_abc', session_id: 'ses_1' },
      contextKeys: ['env'],
    });

    expect(body).toMatchObject({
      // The identity key survives the allowlist; the credential does not.
      tool_context: { env: 'test', session_id: 'ses_1' },
    });
    expect(body).toHaveProperty('tool_context');
    expect(
      (body as { tool_context: Record<string, string> }).tool_context
    ).not.toHaveProperty('ocaToken');
  });

  test('omits tool_context entirely when the allowlist leaves nothing', () => {
    const body = buildSoatRequestBody({
      def: soatDef('create-agent-generation'),
      rawArgs: { agent_id: 'agt_1', messages: [] },
      toolContext: { ocaToken: 'tok_abc' },
      contextKeys: [],
    });

    expect(body).not.toHaveProperty('tool_context');
  });
});

// No write path stores an action the registry does not know, but a row written
// under an earlier registry still names whatever it named then.
describe('resolveSoatTools', () => {
  test('skips a stored action the registry no longer knows', () => {
    const result = resolveSoatTools({
      meter: { projectId: 0, toolId: null, attribution: {} },
      typedTool: {
        name: 'myTool',
        description: null,
        actions: ['completely-unknown-action-xyz', 'list-tools'],
        presetParameters: null,
      },
      buildContextHeaders: () => {
        return {};
      },
      isSoatActionAllowedByBoundary: () => {
        return true;
      },
      logToolCallingError: () => {},
    });
    expect(Object.keys(result)).toEqual(['myTool_list-tools']);
  });
});
