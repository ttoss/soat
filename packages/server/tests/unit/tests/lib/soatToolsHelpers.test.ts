import { extractBodyProps } from 'src/lib/soatToolsHelpers';

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
    expect(result.map((p) => p.snakeName)).toEqual(['name', 'count']);
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
    expect(result.map((p) => p.snakeName)).not.toContain('trace_id');
    expect(result.map((p) => p.snakeName)).not.toContain('parent_trace_id');
    expect(result.map((p) => p.snakeName)).not.toContain('root_trace_id');
  });
});
