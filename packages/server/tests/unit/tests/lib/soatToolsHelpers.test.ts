import {
  buildInputSchema,
  extractBodyProps,
  getJsonSchemaType,
} from 'src/lib/soatToolsHelpers';
import { buildQueryFn } from 'src/lib/soatToolsSchemaHelpers';

describe('getJsonSchemaType', () => {
  test('converts object type to object', () => {
    expect(getJsonSchemaType('object')).toBe('object');
  });

  test('converts integer type to number', () => {
    expect(getJsonSchemaType('integer')).toBe('number');
  });

  test('converts number type to number', () => {
    expect(getJsonSchemaType('number')).toBe('number');
  });

  test('converts boolean type to boolean', () => {
    expect(getJsonSchemaType('boolean')).toBe('boolean');
  });

  test('converts array type to array', () => {
    expect(getJsonSchemaType('array')).toBe('array');
  });

  test('defaults to string for unknown types', () => {
    expect(getJsonSchemaType('string')).toBe('string');
    expect(getJsonSchemaType(undefined)).toBe('string');
    expect(getJsonSchemaType('unknown')).toBe('string');
  });
});

describe('buildInputSchema', () => {
  test('an object-typed body prop is advertised as type object, not string', () => {
    // Reproduces the start-orchestration-run bug: the `input` body field is an
    // object in the OpenAPI spec, but was being declared as `type: string` in
    // the generated MCP tool schema, so object inputs never reached the server.
    const schema = buildInputSchema(
      [],
      [],
      [
        {
          snakeName: 'input',
          camelName: 'input',
          description: 'Initial state for the run.',
          required: false,
          type: 'object',
        },
      ]
    );

    expect(schema.properties?.input).toEqual({
      type: 'object',
      description: 'Initial state for the run.',
    });
  });
});

describe('buildQueryFn', () => {
  test('returns undefined when there are no query params', () => {
    expect(buildQueryFn([])).toBeUndefined();
  });

  test('builds a query string from camelCase args using snake_case keys', () => {
    const fn = buildQueryFn([
      { name: 'project_id', camelName: 'projectId' },
      { name: 'limit', camelName: 'limit' },
    ]);
    expect(fn?.({ projectId: 'prj_01', limit: 50 })).toBe(
      '?project_id=prj_01&limit=50'
    );
  });

  test('omits undefined and null values', () => {
    const fn = buildQueryFn([
      { name: 'project_id', camelName: 'projectId' },
      { name: 'limit', camelName: 'limit' },
    ]);
    expect(fn?.({ projectId: 'prj_01', limit: undefined })).toBe(
      '?project_id=prj_01'
    );
    expect(fn?.({})).toBe('');
  });

  test('repeats the key for array values', () => {
    const fn = buildQueryFn([{ name: 'events', camelName: 'events' }]);
    expect(fn?.({ events: ['a', 'b'] })).toBe('?events=a&events=b');
  });
});

describe('extractBodyProps', () => {
  const emptySpec = {};

  test('returns empty array when no request body', () => {
    expect(extractBodyProps({ spec: emptySpec })).toEqual([]);
  });

  test('includes regular body properties', () => {
    const result = extractBodyProps({
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['name'],
              properties: {
                name: { type: 'string', description: 'The name' },
                count: { type: 'integer', description: 'A count' },
              },
            },
          },
        },
      },
      spec: emptySpec,
    });

    expect(result).toHaveLength(2);
    expect(
      result.map((p) => {
        return p.snakeName;
      })
    ).toEqual(['name', 'count']);
  });

  test('excludes fields marked with x-soat-server-managed', () => {
    const result = extractBodyProps({
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'User message' },
                trace_id: {
                  type: 'string',
                  'x-soat-server-managed': true,
                  description: 'Server-assigned trace ID',
                },
                parent_trace_id: {
                  type: 'string',
                  'x-soat-server-managed': true,
                  description: 'Parent trace ID',
                },
                root_trace_id: {
                  type: 'string',
                  'x-soat-server-managed': true,
                  description: 'Root trace ID',
                },
              },
            },
          },
        },
      },
      spec: emptySpec,
    });

    expect(result).toHaveLength(1);
    expect(result[0].snakeName).toBe('message');
    expect(
      result.map((p) => {
        return p.snakeName;
      })
    ).not.toContain('trace_id');
    expect(
      result.map((p) => {
        return p.snakeName;
      })
    ).not.toContain('parent_trace_id');
    expect(
      result.map((p) => {
        return p.snakeName;
      })
    ).not.toContain('root_trace_id');
  });

  test('flattens oneOf object request bodies into a combined body prop list', () => {
    const result = extractBodyProps({
      requestBody: {
        content: {
          'application/json': {
            schema: {
              oneOf: [
                {
                  type: 'object',
                  required: ['message'],
                  properties: {
                    message: {
                      type: 'string',
                      description: 'User message text',
                    },
                    tool_context: {
                      type: 'object',
                      description: 'Tool context',
                    },
                  },
                },
                {
                  type: 'object',
                  required: ['document_id'],
                  properties: {
                    document_id: {
                      type: 'string',
                      description: 'Document ID',
                    },
                    tool_context: {
                      type: 'object',
                      description: 'Tool context',
                    },
                  },
                },
              ],
            },
          },
        },
      },
      spec: emptySpec,
    });

    expect(
      result.map((p) => {
        return p.snakeName;
      })
    ).toEqual(['message', 'tool_context', 'document_id']);
    expect(
      result.find((p) => {
        return p.snakeName === 'message';
      })?.required
    ).toBe(false);
    expect(
      result.find((p) => {
        return p.snakeName === 'document_id';
      })?.required
    ).toBe(false);
  });
});
