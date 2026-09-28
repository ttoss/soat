import type { OpenApiSpec } from '@ttoss/http-server-mcp-openapi';
import { soatTools } from 'src/lib/soatTools';
import { prepareToolExtensions } from 'src/lib/soatToolsExtensions';

const specWith = (args: {
  parameter?: Record<string, unknown>;
  property?: Record<string, unknown>;
}): OpenApiSpec => {
  return {
    paths: {
      '/api/v1/things': {
        post: {
          operationId: 'createThing',
          parameters: args.parameter ? [args.parameter] : [],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: args.property ? { flag: args.property } : {},
                },
              },
            },
          },
        },
      },
    },
  };
};

/** The value at `keys` under `value`, narrowing through each step. */
const at = (value: unknown, ...keys: Array<string | number>): unknown => {
  return keys.reduce<unknown>((node, key) => {
    if (typeof node !== 'object' || node === null) return undefined;
    return Reflect.get(node, key);
  }, value);
};

const operation = (spec: OpenApiSpec) => {
  return at(spec, 'paths', '/api/v1/things', 'post');
};

const firstParameter = (spec: OpenApiSpec) => {
  return at(operation(spec), 'parameters', 0);
};

const flagProperty = (spec: OpenApiSpec) => {
  return at(
    operation(spec),
    'requestBody',
    'content',
    'application/json',
    'schema',
    'properties',
    'flag'
  );
};

describe('prepareToolExtensions', () => {
  describe('x-soat-tool-forced', () => {
    test('a boolean pin on a boolean query parameter reaches the library as its text', () => {
      const spec = prepareToolExtensions({
        spec: specWith({
          parameter: {
            name: 'wait',
            in: 'query',
            schema: { type: 'boolean' },
            'x-soat-tool-forced': true,
          },
        }),
        file: 'things.yaml',
      });

      expect(firstParameter(spec)).toMatchObject({
        'x-soat-tool-forced': 'true',
      });
    });

    test('a pin on a body property reaches the library as its text', () => {
      const spec = prepareToolExtensions({
        spec: specWith({
          property: { type: 'integer', 'x-soat-tool-forced': 3 },
        }),
        file: 'things.yaml',
      });

      expect(flagProperty(spec)).toMatchObject({ 'x-soat-tool-forced': '3' });
    });

    test('a pin on a string field stays a string', () => {
      const spec = prepareToolExtensions({
        spec: specWith({
          property: { type: 'string', 'x-soat-tool-forced': 'fast' },
        }),
        file: 'things.yaml',
      });

      expect(flagProperty(spec)).toMatchObject({
        'x-soat-tool-forced': 'fast',
      });
    });

    test('a quoted pin on a boolean field is refused', () => {
      expect(() => {
        return prepareToolExtensions({
          spec: specWith({
            parameter: {
              name: 'wait',
              in: 'query',
              schema: { type: 'boolean' },
              'x-soat-tool-forced': 'true',
            },
          }),
          file: 'things.yaml',
        });
      }).toThrow(
        "things.yaml createThing 'wait': x-soat-tool-forced must be a boolean, like the field it pins; got string"
      );
    });

    test('a pin of the wrong type is refused', () => {
      expect(() => {
        return prepareToolExtensions({
          spec: specWith({
            property: { type: 'boolean', 'x-soat-tool-forced': 1 },
          }),
          file: 'things.yaml',
        });
      }).toThrow(
        "things.yaml createThing 'flag': x-soat-tool-forced must be a boolean, like the field it pins; got number"
      );
    });

    test('a pin on a field of no scalar type is refused', () => {
      expect(() => {
        return prepareToolExtensions({
          spec: specWith({
            property: { type: 'object', 'x-soat-tool-forced': true },
          }),
          file: 'things.yaml',
        });
      }).toThrow(
        "things.yaml createThing 'flag': x-soat-tool-forced pins only a boolean, integer, number or string field; got object"
      );
    });
  });

  describe.each(['x-soat-server-managed', 'x-soat-tool-unsupported'])(
    '%s',
    (extension) => {
      test('true is kept', () => {
        const spec = prepareToolExtensions({
          spec: specWith({ property: { type: 'string', [extension]: true } }),
          file: 'things.yaml',
        });

        expect(flagProperty(spec)).toMatchObject({ [extension]: true });
      });

      test('a string, which the library would read as a pin, is refused', () => {
        expect(() => {
          return prepareToolExtensions({
            spec: specWith({
              property: { type: 'string', [extension]: 'yes' },
            }),
            file: 'things.yaml',
          });
        }).toThrow(
          `things.yaml createThing 'flag': ${extension} must be true; got string`
        );
      });
    }
  );

  test('checks a shared component parameter, named by its key', () => {
    expect(() => {
      return prepareToolExtensions({
        spec: {
          paths: {},
          components: {
            parameters: {
              Wait: {
                name: 'wait',
                in: 'query',
                schema: { type: 'boolean' },
                'x-soat-tool-forced': 'true',
              },
            },
          },
        },
        file: 'things.yaml',
      });
    }).toThrow(
      "things.yaml Wait 'wait': x-soat-tool-forced must be a boolean, like the field it pins; got string"
    );
  });

  test('leaves the input spec untouched', () => {
    const input = specWith({
      property: { type: 'boolean', 'x-soat-tool-forced': true },
    });

    prepareToolExtensions({ spec: input, file: 'things.yaml' });

    expect(flagProperty(input)).toMatchObject({ 'x-soat-tool-forced': true });
  });
});

describe('the loaded tools', () => {
  const tool = (name: string) => {
    const found = soatTools.find((t) => {
      return t.name === name;
    });
    if (!found) throw new Error(`no tool ${name}`);
    return found;
  };

  test.each([
    'create-agent-generation',
    'generate-conversation-message',
    'generate-session-response',
  ])('%s sends wait=true whatever the caller passes', (name) => {
    expect(tool(name).query?.({ wait: false })).toContain('wait=true');
  });

  test('create-decision sends the boolean true in its body', () => {
    expect(tool('create-decision').body?.({ wait: false })).toMatchObject({
      wait: true,
    });
  });
});
