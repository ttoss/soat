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
});
