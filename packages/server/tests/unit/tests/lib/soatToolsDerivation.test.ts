import { deriveToolDefinitions } from 'src/lib/soatToolsDerivation';

const operation = (operationId: string) => {
  return { post: { operationId, responses: {} } };
};

describe('deriveToolDefinitions', () => {
  test('derives a tool for each REST operation and none for a root path', () => {
    const tools = deriveToolDefinitions({
      specs: [
        {
          file: 'things.yaml',
          spec: {
            paths: {
              '/api/v1/things': operation('createThing'),
              '/token': operation('issueToken'),
            },
          },
        },
      ],
    });

    expect(
      tools.map((tool) => {
        return tool.operationId;
      })
    ).toEqual(['createThing']);
  });

  test('a spec with no paths, only shared components, derives no tool', () => {
    expect(
      deriveToolDefinitions({
        specs: [{ file: 'tags.yaml', spec: { components: { schemas: {} } } }],
      })
    ).toEqual([]);
  });

  test('a body whose union only says which fields are required keeps its own properties', () => {
    const [tool] = deriveToolDefinitions({
      specs: [
        {
          file: 'things.yaml',
          spec: {
            paths: {
              '/api/v1/things': {
                post: {
                  operationId: 'createThing',
                  responses: {},
                  requestBody: {
                    content: {
                      'application/json': {
                        schema: {
                          type: 'object',
                          required: ['name'],
                          oneOf: [
                            { required: ['tool_id'] },
                            { required: ['agent_id'] },
                          ],
                          properties: {
                            name: { type: 'string' },
                            tool_id: { type: 'string' },
                            agent_id: { type: 'string' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      ],
    });

    expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual([
      'name',
      'tool_id',
      'agent_id',
    ]);
    expect(tool.inputSchema.required).toEqual(['name']);
    expect(tool.inputSchema).not.toHaveProperty('oneOf');
  });
});
