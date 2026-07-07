type MergedSpec = {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, unknown>;
  components: {
    schemas: Record<string, unknown>;
    securitySchemes: Record<string, unknown>;
  };
};

type RequestSchemaFields = {
  allowedFields: Set<string>;
  requiredFields: Set<string>;
};

type OpenapiSpecModule = {
  loadMergedOpenApiSpec: () => MergedSpec;
  getMergedOpenApiSpec: () => MergedSpec;
  getRequestSchemaFields: (args: { schemaName: string }) => RequestSchemaFields;
  getRouteRequestSchemaFields: (args: {
    method: string;
    path: string;
  }) => RequestSchemaFields | null;
  getRouteRequestSchema: (args: {
    method: string;
    path: string;
  }) => Record<string, unknown> | null;
  resolveSchemaRef: (schema: unknown) => Record<string, unknown> | null;
  matchOpenApiPath: (args: { path: string }) => string | null;
};

describe('openapiSpec', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.unmock('node:fs');
    jest.unmock('js-yaml');
  });

  test('returns empty spec when specDir does not exist', () => {
    jest.doMock('node:fs', () => {
      return {
        existsSync: jest.fn(() => {
          return false;
        }),
        readdirSync: jest.fn(),
        readFileSync: jest.fn(),
      };
    });

    const { loadMergedOpenApiSpec } = jest.requireActual(
      'src/lib/openapiSpec'
    ) as OpenapiSpecModule;

    const spec = loadMergedOpenApiSpec();
    expect(spec.openapi).toBe('3.0.3');
    expect(spec.paths).toEqual({});
    expect(spec.components.schemas).toEqual({});
    expect(spec.components.securitySchemes).toEqual({});
  });

  test('skips files that fail to parse and returns empty spec', () => {
    jest.doMock('node:fs', () => {
      return {
        existsSync: jest.fn(() => {
          return true;
        }),
        readdirSync: jest.fn(() => {
          return ['broken.yaml'];
        }),
        readFileSync: jest.fn(() => {
          throw new Error('read error');
        }),
      };
    });

    const { loadMergedOpenApiSpec } = jest.requireActual(
      'src/lib/openapiSpec'
    ) as OpenapiSpecModule;

    const spec = loadMergedOpenApiSpec();
    expect(spec.paths).toEqual({});
  });

  test('merges spec with no paths or components gracefully', () => {
    jest.doMock('node:fs', () => {
      return {
        existsSync: jest.fn(() => {
          return true;
        }),
        readdirSync: jest.fn(() => {
          return ['minimal.yaml'];
        }),
        readFileSync: jest.fn(() => {
          return 'openapi: 3.0.0';
        }),
      };
    });

    jest.doMock('js-yaml', () => {
      return {
        load: jest.fn(() => {
          return { openapi: '3.0.0' };
        }),
      };
    });

    const { loadMergedOpenApiSpec } = jest.requireActual(
      'src/lib/openapiSpec'
    ) as OpenapiSpecModule;

    const spec = loadMergedOpenApiSpec();
    expect(spec.paths).toEqual({});
    expect(spec.components.schemas).toEqual({});
    expect(spec.components.securitySchemes).toEqual({});
  });

  test('merges spec with components but no securitySchemes', () => {
    jest.doMock('node:fs', () => {
      return {
        existsSync: jest.fn(() => {
          return true;
        }),
        readdirSync: jest.fn(() => {
          return ['partial.yaml'];
        }),
        readFileSync: jest.fn(() => {
          return '';
        }),
      };
    });

    jest.doMock('js-yaml', () => {
      return {
        load: jest.fn(() => {
          return {
            paths: { '/test': { get: {} } },
            components: { schemas: { Foo: { type: 'object' } } },
          };
        }),
      };
    });

    const { loadMergedOpenApiSpec } = jest.requireActual(
      'src/lib/openapiSpec'
    ) as OpenapiSpecModule;

    const spec = loadMergedOpenApiSpec();
    expect(spec.paths['/test']).toBeDefined();
    expect(spec.components.schemas['Foo']).toBeDefined();
    expect(spec.components.securitySchemes).toEqual({});
  });

  test('getMergedOpenApiSpec caches the result on second call', () => {
    jest.doMock('node:fs', () => {
      return {
        existsSync: jest.fn(() => {
          return true;
        }),
        readdirSync: jest.fn(() => {
          return ['spec.yaml'];
        }),
        readFileSync: jest.fn(() => {
          return '';
        }),
      };
    });

    jest.doMock('js-yaml', () => {
      return {
        load: jest.fn(() => {
          return { paths: { '/cached': {} } };
        }),
      };
    });

    const { getMergedOpenApiSpec } = jest.requireActual(
      'src/lib/openapiSpec'
    ) as OpenapiSpecModule;

    const first = getMergedOpenApiSpec();
    const second = getMergedOpenApiSpec();
    expect(first).toBe(second);
  });

  describe('getRequestSchemaFields', () => {
    // These tests read the real OpenAPI specs on disk — the spec is the
    // contract under test, so there is nothing to mock. fs/js-yaml are only
    // mocked elsewhere in this file to simulate conditions that cannot be
    // produced with the real spec (missing dir, unparseable file).
    const { getRequestSchemaFields } = jest.requireActual(
      'src/lib/openapiSpec'
    ) as OpenapiSpecModule;

    test('derives camelCase allowed and required fields from the real spec', () => {
      const create = getRequestSchemaFields({
        schemaName: 'CreateAgentRequest',
      });

      // snake_case spec properties are returned in camelCase
      expect(create.allowedFields.has('aiProviderId')).toBe(true);
      expect(create.allowedFields.has('maxSteps')).toBe(true);
      expect(create.allowedFields.has('singleSessionPerActor')).toBe(true);
      expect(create.allowedFields.has('knowledgeConfig')).toBe(true);

      // conversion is exhaustive — no snake_case leaks through
      for (const field of create.allowedFields) {
        expect(field).not.toContain('_');
      }

      // required is derived from the schema's `required` array
      expect([...create.requiredFields]).toEqual(['aiProviderId']);
    });

    test('distinguishes create-only fields from updatable ones', () => {
      const create = getRequestSchemaFields({
        schemaName: 'CreateAgentRequest',
      });
      const update = getRequestSchemaFields({
        schemaName: 'UpdateAgentRequest',
      });

      expect(create.allowedFields.has('projectId')).toBe(true);
      // projectId is create-only — it must not be an updatable field
      expect(update.allowedFields.has('projectId')).toBe(false);
      expect(update.allowedFields.has('aiProviderId')).toBe(true);
      // UpdateAgentRequest has no required fields
      expect(update.requiredFields.size).toBe(0);
    });

    test('throws for a schema that is absent from the spec', () => {
      expect(() => {
        return getRequestSchemaFields({ schemaName: 'NoSuchSchema' });
      }).toThrow(/no properties/);
    });
  });

  describe('getRouteRequestSchemaFields', () => {
    const { getRouteRequestSchemaFields } = jest.requireActual(
      'src/lib/openapiSpec'
    ) as OpenapiSpecModule;

    test('resolves a $ref request body and normalizes :param + prefix', () => {
      const fields = getRouteRequestSchemaFields({
        method: 'put',
        path: '/agents/:agent_id',
      });
      expect(fields).not.toBeNull();
      expect(fields!.allowedFields.has('aiProviderId')).toBe(true);
      // create-only field is absent from UpdateAgentRequest
      expect(fields!.allowedFields.has('projectId')).toBe(false);
    });

    test('resolves an inline request body schema', () => {
      const fields = getRouteRequestSchemaFields({
        method: 'post',
        path: '/projects',
      });
      expect(fields).not.toBeNull();
      expect(fields!.allowedFields.has('name')).toBe(true);
    });

    test('is case-insensitive on the HTTP method', () => {
      const fields = getRouteRequestSchemaFields({
        method: 'POST',
        path: '/agents',
      });
      expect(fields?.allowedFields.has('aiProviderId')).toBe(true);
    });

    test('returns null for an open additionalProperties map (tags)', () => {
      expect(
        getRouteRequestSchemaFields({
          method: 'put',
          path: '/actors/:actor_id/tags',
        })
      ).toBeNull();
    });

    test('returns null for an unknown route', () => {
      expect(
        getRouteRequestSchemaFields({ method: 'post', path: '/nope' })
      ).toBeNull();
    });

    test('returns null for an unsupported method', () => {
      expect(
        getRouteRequestSchemaFields({ method: 'options', path: '/agents' })
      ).toBeNull();
    });
  });

  describe('getRouteRequestSchema', () => {
    const { getRouteRequestSchema } = jest.requireActual(
      'src/lib/openapiSpec'
    ) as OpenapiSpecModule;

    test('returns the resolved $ref schema object for a route', () => {
      const schema = getRouteRequestSchema({ method: 'post', path: '/agents' });
      expect(schema).not.toBeNull();
      // resolved to CreateAgentRequest — has snake_case properties
      expect(
        (schema!.properties as Record<string, unknown>).ai_provider_id
      ).toBeDefined();
    });

    test('returns an inline schema object for a route', () => {
      const schema = getRouteRequestSchema({
        method: 'post',
        path: '/projects',
      });
      expect(
        (schema!.properties as Record<string, unknown>).name
      ).toBeDefined();
    });

    test('returns null for a route with no JSON body', () => {
      expect(
        getRouteRequestSchema({ method: 'get', path: '/agents' })
      ).toBeNull();
    });
  });

  describe('resolveSchemaRef', () => {
    const { resolveSchemaRef } = jest.requireActual(
      'src/lib/openapiSpec'
    ) as OpenapiSpecModule;

    test('follows a $ref to its named component schema', () => {
      const resolved = resolveSchemaRef({
        $ref: '#/components/schemas/CreateAgentRequest',
      });
      expect(resolved).not.toBeNull();
      expect(
        (resolved!.properties as Record<string, unknown>).ai_provider_id
      ).toBeDefined();
    });

    test('returns an inline schema unchanged', () => {
      const inline = { type: 'object', properties: { a: {} } };
      expect(resolveSchemaRef(inline)).toBe(inline);
    });

    test('returns null for a non-object or unresolvable ref', () => {
      expect(resolveSchemaRef(null)).toBeNull();
      expect(
        resolveSchemaRef({ $ref: '#/components/schemas/NoSuchSchema' })
      ).toBeNull();
    });
  });

  describe('matchOpenApiPath', () => {
    const { matchOpenApiPath } = jest.requireActual(
      'src/lib/openapiSpec'
    ) as OpenapiSpecModule;

    test('matches a static collection path', () => {
      expect(matchOpenApiPath({ path: '/api/v1/agents' })).toBe(
        '/api/v1/agents'
      );
    });

    test('matches a parameterized path to its template', () => {
      expect(matchOpenApiPath({ path: '/api/v1/agents/agt_123' })).toBe(
        '/api/v1/agents/{agent_id}'
      );
    });

    test('prefers a static segment over a parameterized one', () => {
      // /orchestrations/validate is static; it must win over any
      // /orchestrations/{...} template of the same length.
      expect(
        matchOpenApiPath({ path: '/api/v1/orchestrations/validate' })
      ).toBe('/api/v1/orchestrations/validate');
    });

    test('matches a nested parameterized path', () => {
      expect(matchOpenApiPath({ path: '/api/v1/actors/act_1/tags' })).toBe(
        '/api/v1/actors/{actor_id}/tags'
      );
    });

    test('returns null when no template matches', () => {
      expect(matchOpenApiPath({ path: '/api/v1/does/not/exist' })).toBeNull();
    });
  });
});
