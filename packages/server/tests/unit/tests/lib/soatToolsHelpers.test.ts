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
          name: 'input',
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

  describe('nullable and property-level oneOf/anyOf', () => {
    // The generated schema is what an MCP client is told it may send. Collapsing
    // a nullable or multi-shape property to one primitive advertises a stricter
    // contract than the REST API enforces, so a documented call — "pass null to
    // clear this field" — looks invalid to anything validating against it.

    test('a nullable property keeps its declared type as a two-entry type array', () => {
      const schema = buildInputSchema(
        [],
        [],
        [
          {
            name: 'max_context_messages',
            description: 'Maximum recent messages. Null means no limit.',
            required: false,
            type: 'integer',
            nullable: true,
          },
        ]
      );

      expect(schema.properties?.max_context_messages).toEqual({
        type: ['number', 'null'],
        description: 'Maximum recent messages. Null means no limit.',
      });
    });

    test('a nullable array keeps its items schema alongside the null type', () => {
      const schema = buildInputSchema(
        [],
        [],
        [
          {
            name: 'tags',
            description: 'Pass null or an empty array to clear.',
            required: false,
            type: 'array',
            items: { type: 'string' },
            nullable: true,
          },
        ]
      );

      expect(schema.properties?.tags).toEqual({
        type: ['array', 'null'],
        items: { type: 'string' },
        description: 'Pass null or an empty array to clear.',
      });
    });

    test('a property-level oneOf is forwarded verbatim, not collapsed to a primitive', () => {
      const oneOf = [
        { type: 'string', enum: ['auto', 'required'] },
        {
          type: 'object',
          properties: { type: { type: 'string' }, name: { type: 'string' } },
        },
      ];

      const schema = buildInputSchema(
        [],
        [],
        [
          {
            name: 'tool_choice',
            description: 'Accepts a string or an object.',
            required: false,
            // A declared `type` must not win over the spec's own alternatives.
            type: 'string',
            oneOf,
          },
        ]
      );

      expect(schema.properties?.tool_choice).toEqual({
        oneOf,
        description: 'Accepts a string or an object.',
      });
    });

    test('a property-level anyOf is forwarded verbatim', () => {
      const anyOf = [
        { type: 'array', items: { type: 'string' } },
        { type: 'null' },
      ];

      const schema = buildInputSchema(
        [],
        [],
        [
          {
            name: 'labels',
            description: 'Labels, or null to clear them.',
            required: false,
            type: 'array',
            anyOf,
          },
        ]
      );

      expect(schema.properties?.labels).toEqual({
        anyOf,
        description: 'Labels, or null to clear them.',
      });
    });

    test('a property the spec gives no type is advertised without one', () => {
      // agents.yaml declares `tool_choice` with only `nullable` and a
      // description saying it accepts a string *or* an object. Guessing
      // `string` made the documented object form look invalid.
      const schema = buildInputSchema(
        [],
        [],
        [
          {
            name: 'tool_choice',
            description: 'Accepts a string or an object.',
            required: false,
            type: undefined,
            nullable: true,
          },
        ]
      );

      expect(schema.properties?.tool_choice).toEqual({
        description: 'Accepts a string or an object.',
      });
    });

    test('an untyped property still prefers its oneOf when the spec declares one', () => {
      const oneOf = [{ type: 'string' }, { type: 'object' }];

      const schema = buildInputSchema(
        [],
        [],
        [
          {
            name: 'target',
            description: 'Either shape.',
            required: false,
            type: undefined,
            oneOf,
          },
        ]
      );

      expect(schema.properties?.target).toEqual({
        oneOf,
        description: 'Either shape.',
      });
    });

    test('nested OpenAPI nullable inside a forwarded oneOf is translated too', () => {
      // The formation specs declare `nullable` several levels down, inside a
      // oneOf alternative's additionalProperties. Left as-is, the MCP
      // validator rejects the whole tool: `nullable` is not a JSON Schema
      // keyword.
      const schema = buildInputSchema(
        [],
        [],
        [
          {
            name: 'parameters',
            description: 'Formation parameters.',
            required: false,
            type: undefined,
            oneOf: [
              {
                type: 'object',
                additionalProperties: {
                  type: 'object',
                  properties: {
                    default: { type: 'string', nullable: true },
                  },
                },
              },
            ],
          },
        ]
      );

      expect(schema.properties?.parameters).toEqual({
        oneOf: [
          {
            type: 'object',
            additionalProperties: {
              type: 'object',
              properties: {
                default: { type: ['string', 'null'] },
              },
            },
          },
        ],
        description: 'Formation parameters.',
      });
    });

    test('nested nullable inside array items is translated', () => {
      const schema = buildInputSchema(
        [],
        [],
        [
          {
            name: 'entries',
            description: 'Entries.',
            required: false,
            type: 'array',
            items: {
              type: 'object',
              properties: { note: { type: 'string', nullable: true } },
            },
          },
        ]
      );

      expect(schema.properties?.entries).toEqual({
        type: 'array',
        items: {
          type: 'object',
          properties: { note: { type: ['string', 'null'] } },
        },
        description: 'Entries.',
      });
    });

    test('a non-nullable property is unaffected', () => {
      const schema = buildInputSchema(
        [],
        [],
        [
          {
            name: 'name',
            description: 'The name',
            required: true,
            type: 'string',
          },
        ]
      );

      expect(schema.properties?.name).toEqual({
        type: 'string',
        description: 'The name',
      });
    });
  });
});

describe('buildQueryFn', () => {
  test('returns undefined when there are no query params', () => {
    expect(buildQueryFn([])).toBeUndefined();
  });

  test("builds a query string from the spec's own snake_case names", () => {
    const fn = buildQueryFn([{ name: 'project_id' }, { name: 'limit' }]);
    expect(fn?.({ project_id: 'prj_01', limit: 50 })).toBe(
      '?project_id=prj_01&limit=50'
    );
  });

  test('ignores a camelCase arg — the tool schema advertises snake_case', () => {
    const fn = buildQueryFn([{ name: 'project_id' }]);
    expect(fn?.({ projectId: 'prj_01' })).toBe('');
  });

  test('omits undefined and null values', () => {
    const fn = buildQueryFn([{ name: 'project_id' }, { name: 'limit' }]);
    expect(fn?.({ project_id: 'prj_01', limit: undefined })).toBe(
      '?project_id=prj_01'
    );
    expect(fn?.({})).toBe('');
  });

  test('repeats the key for array values', () => {
    const fn = buildQueryFn([{ name: 'events' }]);
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
        return p.name;
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
    expect(result[0].name).toBe('message');
    expect(
      result.map((p) => {
        return p.name;
      })
    ).not.toContain('trace_id');
    expect(
      result.map((p) => {
        return p.name;
      })
    ).not.toContain('parent_trace_id');
    expect(
      result.map((p) => {
        return p.name;
      })
    ).not.toContain('root_trace_id');
  });

  test('surfaces nullable and property-level oneOf/anyOf from the spec', () => {
    const result = extractBodyProps({
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                description: {
                  type: 'string',
                  description: 'Nullable description',
                  nullable: true,
                },
                tool_choice: {
                  description: 'String or object',
                  oneOf: [{ type: 'string' }, { type: 'object' }],
                },
                labels: {
                  description: 'Array or null',
                  anyOf: [{ type: 'array' }, { type: 'null' }],
                },
                name: { type: 'string', description: 'Plain' },
              },
            },
          },
        },
      },
      spec: emptySpec,
    });

    const byName = (name: string) => {
      return result.find((p) => {
        return p.name === name;
      });
    };

    expect(byName('description')?.nullable).toBe(true);
    expect(byName('tool_choice')?.oneOf).toEqual([
      { type: 'string' },
      { type: 'object' },
    ]);
    expect(byName('labels')?.anyOf).toEqual([
      { type: 'array' },
      { type: 'null' },
    ]);
    expect(byName('name')?.nullable).toBe(false);
    expect(byName('name')?.oneOf).toBeUndefined();
    expect(byName('name')?.anyOf).toBeUndefined();
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
        return p.name;
      })
    ).toEqual(['message', 'tool_context', 'document_id']);
    expect(
      result.find((p) => {
        return p.name === 'message';
      })?.required
    ).toBe(false);
    expect(
      result.find((p) => {
        return p.name === 'document_id';
      })?.required
    ).toBe(false);
  });

  test('deep-resolves $refs nested inside array item properties (issue #344)', () => {
    // Reproduces the create-agent-generation bug: messages[].content is a
    // oneOf containing $refs to components/schemas. Those refs must be
    // inlined before the schema reaches an LLM provider as a tool
    // definition, since the provider-facing schema has no `components`
    // section to resolve against.
    const spec = {
      components: {
        schemas: {
          ToolOutputMessageContent: {
            type: 'object',
            required: ['type', 'tool_id'],
            properties: {
              type: { type: 'string', enum: ['tool_output'] },
              tool_id: { type: 'string' },
            },
          },
        },
      },
    };

    const result = extractBodyProps({
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['messages'],
              properties: {
                messages: {
                  type: 'array',
                  description: 'Conversation messages',
                  items: {
                    type: 'object',
                    properties: {
                      role: { type: 'string' },
                      content: {
                        oneOf: [
                          { type: 'string' },
                          {
                            $ref: '#/components/schemas/ToolOutputMessageContent',
                          },
                        ],
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      spec,
    });

    const messagesProp = result.find((p) => {
      return p.name === 'messages';
    });

    expect(messagesProp).toBeDefined();
    expect(JSON.stringify(messagesProp?.items)).not.toContain('$ref');

    const resolvedAlternative = (
      messagesProp?.items as {
        properties: {
          content: {
            oneOf: Array<{
              properties?: { tool_id?: { type?: string } };
            }>;
          };
        };
      }
    ).properties.content.oneOf[1];

    expect(resolvedAlternative.properties?.tool_id?.type).toBe('string');
  });
});
