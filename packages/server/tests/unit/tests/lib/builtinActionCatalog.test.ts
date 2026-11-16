import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  findBuiltinAction,
  initBuiltinActionCatalog,
  parseBuiltinActionCatalog,
  registerBuiltinActionCatalog,
  resetBuiltinActionCatalog,
} from 'src/lib/builtinActionCatalog';
import { IAM_REGISTRATIONS_CONFIG_ENV } from 'src/lib/iamRegistrations';

/** Boot config: no request reaches the parser, so it is tested here. */
const parse = (builtinActions: unknown) => {
  return parseBuiltinActionCatalog({
    config: { modules: [], builtin_actions: builtinActions },
    source: 'test',
  });
};

const ADD = {
  url: 'https://svc.example/mcp/',
  tools: {
    'send-note': [{ action: 'secrets:ListSecrets', resource_type: 'secret' }],
  },
};

const savedKey = process.env.TOOL_ASSERTION_PRIVATE_KEY;

afterEach(() => {
  resetBuiltinActionCatalog();
  if (savedKey === undefined) delete process.env.TOOL_ASSERTION_PRIVATE_KEY;
  else process.env.TOOL_ASSERTION_PRIVATE_KEY = savedKey;
});

describe('parseBuiltinActionCatalog', () => {
  test('reads the native actions offered and the server adding its own', () => {
    const catalog = parse({ allow: ['list-agents'], add: ADD });
    expect([...(catalog.allow ?? [])]).toEqual(['list-agents']);
    expect(catalog.added?.url).toBe('https://svc.example/mcp');
    expect(catalog.added?.tools.get('send-note')).toEqual([
      { action: 'secrets:ListSecrets', resourceType: 'secret' },
    ]);
  });

  test('offers every native action and adds none when absent', () => {
    expect(
      parseBuiltinActionCatalog({ config: { modules: [] }, source: 'test' })
    ).toEqual({ allow: null, added: null });
    expect(parse({})).toEqual({ allow: null, added: null });
  });

  test('refuses an allowed name that is not a native action', () => {
    expect(() => {
      return parse({ allow: ['send-note'] });
    }).toThrow(/'send-note' is not a native action/);
  });

  test('refuses an added name that collides with a native one', () => {
    expect(() => {
      return parse({
        add: {
          url: ADD.url,
          tools: {
            'list-agents': [
              { action: 'agents:ListAgents', resource_type: 'agent' },
            ],
          },
        },
      });
    }).toThrow(/'list-agents' is a native action/);
  });

  test('refuses an added server shaped unlike an mcp_tools entry', () => {
    expect(() => {
      return parse({ add: { url: 'nope', tools: ADD.tools } });
    }).toThrow(/builtin_actions.add`.url must be an http\(s\) URL/);
  });
});

describe('registerBuiltinActionCatalog', () => {
  test('refuses added actions with no tool assertion to send them', () => {
    delete process.env.TOOL_ASSERTION_PRIVATE_KEY;
    expect(() => {
      registerBuiltinActionCatalog(parse({ add: ADD }));
    }).toThrow(/TOOL_ASSERTION_PRIVATE_KEY/);
  });

  test('refuses an added action iam/check would not answer', () => {
    process.env.TOOL_ASSERTION_PRIVATE_KEY = crypto
      .generateKeyPairSync('ed25519')
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    expect(() => {
      registerBuiltinActionCatalog(
        parse({
          add: {
            url: ADD.url,
            tools: {
              'send-note': [
                { action: 'notes:SendNote', resource_type: 'note' },
              ],
            },
          },
        })
      );
    }).toThrow(/declares notes:SendNote/);
  });

  test('withholds a native action outside allow', () => {
    registerBuiltinActionCatalog(parse({ allow: ['list-agents'] }));
    expect(findBuiltinAction('list-agents')?.kind).toBe('native');
    expect(findBuiltinAction('get-agent')).toBeUndefined();
  });
});

describe('initBuiltinActionCatalog', () => {
  afterEach(() => {
    delete process.env[IAM_REGISTRATIONS_CONFIG_ENV];
  });

  test('offers every native action when no file is named', () => {
    initBuiltinActionCatalog();
    expect(findBuiltinAction('get-agent')?.kind).toBe('native');
  });

  test('registers the catalog the IAM registrations file declares', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'builtin-catalog-'));
    const file = path.join(dir, 'iam.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        modules: [],
        builtin_actions: { allow: ['list-agents'] },
      })
    );
    process.env[IAM_REGISTRATIONS_CONFIG_ENV] = file;

    initBuiltinActionCatalog();

    expect(findBuiltinAction('list-agents')?.kind).toBe('native');
    expect(findBuiltinAction('get-agent')).toBeUndefined();
  });
});
