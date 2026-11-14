import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { IAM_REGISTRATIONS_CONFIG_ENV } from 'src/lib/iamRegistrations';
import {
  findMcpToolRegistration,
  initMcpToolRegistrations,
  parseMcpToolRegistrations,
  registerMcpTools,
  unregisterMcpTools,
} from 'src/lib/mcpToolRegistrations';

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

describe('parseMcpToolRegistrations rejects a malformed server', () => {
  const tools = {
    a: [{ action: 'agents:ListAgents', resource_type: 'agent' }],
  };

  test.each([
    ['`mcp_tools` not an array', { mcp_tools: {} }, /must be an array/],
    [
      'a url that is not http(s)',
      { mcp_tools: [{ url: 'ftp://svc.example', tools }] },
      /mcp_tools\[0\].url must be an http\(s\) URL/,
    ],
    ['an entry that is not an object', { mcp_tools: ['x'] }, /url must be/],
    [
      'no tools',
      { mcp_tools: [{ url: 'https://svc.example/mcp', tools: {} }] },
      /tools must map each tool name/,
    ],
    [
      'an action entry that is not an object',
      { mcp_tools: [{ url: 'https://svc.example/mcp', tools: { a: ['x'] } }] },
      /action must be <module>:<Operation>/,
    ],
    [
      'a malformed resource type',
      {
        mcp_tools: [
          {
            url: 'https://svc.example/mcp',
            tools: {
              a: [{ action: 'agents:ListAgents', resource_type: 'A-' }],
            },
          },
        ],
      },
      /resource_type must be an SRN resource type/,
    ],
  ])('%s', (_name, config, message) => {
    expect(() => {
      return parse(config);
    }).toThrow(message);
  });

  test('a config that is not an object declares nothing', () => {
    expect(parse(null)).toEqual([]);
  });
});

describe('registerMcpTools', () => {
  test('refuses an action iam/check does not answer on its type', () => {
    expect(() => {
      return registerMcpTools({
        registrations: parse({
          mcp_tools: [
            {
              url: 'https://svc.example/mcp',
              tools: {
                a: [{ action: 'agents:ListAgents', resource_type: 'file' }],
              },
            },
          ],
        }),
      });
    }).toThrow(
      /MCP server https:\/\/svc.example\/mcp declares agents:ListAgents/
    );
    expect(findMcpToolRegistration('https://svc.example/mcp')).toBeUndefined();
  });
});

describe('initMcpToolRegistrations', () => {
  afterEach(() => {
    delete process.env[IAM_REGISTRATIONS_CONFIG_ENV];
    unregisterMcpTools({ urls: ['https://svc.example/mcp'] });
  });

  test('registers nothing when no file is named', () => {
    initMcpToolRegistrations();
    expect(findMcpToolRegistration('https://svc.example/mcp')).toBeUndefined();
  });

  test('registers the servers the IAM registrations file declares', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-reg-'));
    const file = path.join(dir, 'iam.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        modules: [],
        mcp_tools: [
          {
            url: 'https://svc.example/mcp',
            tools: {
              'list-agents': [
                { action: 'agents:ListAgents', resource_type: 'agent' },
              ],
            },
          },
        ],
      })
    );
    process.env[IAM_REGISTRATIONS_CONFIG_ENV] = file;

    initMcpToolRegistrations();

    expect(
      findMcpToolRegistration('https://svc.example/mcp/')?.tools.get(
        'list-agents'
      )
    ).toEqual([{ action: 'agents:ListAgents', resourceType: 'agent' }]);
  });
});
