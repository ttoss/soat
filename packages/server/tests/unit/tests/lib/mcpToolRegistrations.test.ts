import { parseMcpToolRegistrations } from 'src/lib/mcpToolRegistrations';

const parse = (config: unknown) => {
  return parseMcpToolRegistrations({ config, source: 'test' });
};

describe('parseMcpToolRegistrations', () => {
  test('reads each server and the actions each of its tools performs', () => {
    const [registration] = parse({
      modules: [],
      mcp_tools: [
        {
          url: 'https://svc.example/mcp/',
          tools: {
            'list-agents': [
              { action: 'agents:ListAgents', resource_type: 'agent' },
            ],
          },
        },
      ],
    });
    expect(registration.url).toBe('https://svc.example/mcp');
    expect(registration.tools.get('list-agents')).toEqual([
      { action: 'agents:ListAgents', resourceType: 'agent' },
    ]);
  });

  test('declares nothing when absent', () => {
    expect(parse({ modules: [] })).toEqual([]);
  });

  test('rejects a tool declaring no actions, or a malformed one', () => {
    expect(() => {
      return parse({
        mcp_tools: [{ url: 'https://svc.example/mcp', tools: { a: [] } }],
      });
    }).toThrow(/mcp_tools\[0\].tools.a must be a non-empty array/);
    expect(() => {
      return parse({
        mcp_tools: [
          {
            url: 'https://svc.example/mcp',
            tools: { a: [{ action: 'nope', resource_type: 'agent' }] },
          },
        ],
      });
    }).toThrow(/action must be <module>:<Operation>/);
  });

  test('rejects a server declared twice', () => {
    const entry = {
      url: 'https://svc.example/mcp',
      tools: { a: [{ action: 'agents:ListAgents', resource_type: 'agent' }] },
    };
    expect(() => {
      return parse({
        mcp_tools: [entry, { ...entry, url: 'https://svc.example/mcp/' }],
      });
    }).toThrow(/declared more than once/);
  });
});
