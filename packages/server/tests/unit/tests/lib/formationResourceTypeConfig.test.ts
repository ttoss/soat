import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  FORMATION_RESOURCE_TYPES_CONFIG_ENV,
  loadFormationResourceTypeConfig,
  parseFormationResourceTypeConfig,
} from 'src/lib/formationResourceTypeConfig';
import {
  getFormationModule,
  initFormationResourceTypes,
  supportedResourceTypes,
  unregisterFormationResourceTypes,
} from 'src/lib/formationsRegistry';

// ── About this file ─────────────────────────────────────────────────────────
//
// The operator config file that registers custom formation resource types is
// parsed once, at boot, and every rejection here is a hard boot failure. That
// makes the parser a pure function over a large input space whose failure
// signal (the process refusing to start) says nothing about *which* rule fired
// — a `lib/` test per the keep-list rule in `.claude/rules/tests.md`.

const BUILT_INS = new Set(['agent', 'tool', 'model_route']);

const ENV = { CHANNEL_HANDLER_SECRET: 'shhh' };

const VALID_ENTRY = {
  name: 'channel',
  description: 'A messaging channel.',
  handler: {
    url: 'https://platform.internal/v1/formation-resources',
    secret_env: 'CHANNEL_HANDLER_SECRET',
  },
  capabilities: ['validate', 'read'],
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      kind: { type: 'string' },
      agent_id: { type: 'string' },
    },
    required: ['name', 'kind'],
  },
};

const parse = (config: unknown) => {
  return parseFormationResourceTypeConfig({
    config,
    builtInTypes: BUILT_INS,
    env: ENV,
    source: '/etc/soat/formation-resource-types.json',
  });
};

describe('parseFormationResourceTypeConfig', () => {
  describe('a valid config', () => {
    test('returns one registration per declared type', () => {
      const registrations = parse({ resource_types: [VALID_ENTRY] });

      expect(registrations).toHaveLength(1);
      expect(registrations[0].name).toBe('channel');
      expect(registrations[0].description).toBe('A messaging channel.');
      expect(registrations[0].handler.url).toBe(
        'https://platform.internal/v1/formation-resources'
      );
    });

    test('resolves the handler secret from the named environment variable', () => {
      // The config file names the variable; it never carries the secret itself.
      const [registration] = parse({ resource_types: [VALID_ENTRY] });
      expect(registration.handler.secret).toBe('shhh');
    });

    test('derives the schema field sets used to validate template properties', () => {
      const [registration] = parse({ resource_types: [VALID_ENTRY] });

      expect([...registration.schemaFields.allowedFields].sort()).toEqual([
        'agent_id',
        'kind',
        'name',
      ]);
      expect([...registration.schemaFields.requiredFields].sort()).toEqual([
        'kind',
        'name',
      ]);
      expect(registration.schemaFields.fieldSpecs.name.type).toBe('string');
    });

    test('capabilities list only the optional operations', () => {
      const [registration] = parse({ resource_types: [VALID_ENTRY] });
      expect(registration.capabilities.has('validate')).toBe(true);
      expect(registration.capabilities.has('read')).toBe(true);
    });

    test('capabilities default to none when omitted', () => {
      const { capabilities: _omitted, ...entry } = VALID_ENTRY;
      const [registration] = parse({ resource_types: [entry] });

      expect(registration.capabilities.size).toBe(0);
    });

    test('an empty resource_types list registers nothing', () => {
      expect(parse({ resource_types: [] })).toEqual([]);
    });

    test('timeout defaults to 30 seconds and is honoured when declared', () => {
      const [defaulted] = parse({ resource_types: [VALID_ENTRY] });
      expect(defaulted.handler.timeoutMs).toBe(30_000);

      const [declared] = parse({
        resource_types: [
          {
            ...VALID_ENTRY,
            handler: { ...VALID_ENTRY.handler, timeout_seconds: 5 },
          },
        ],
      });
      expect(declared.handler.timeoutMs).toBe(5_000);
    });

    test('an http handler URL is accepted, for a handler on a private network', () => {
      const [registration] = parse({
        resource_types: [
          {
            ...VALID_ENTRY,
            handler: {
              ...VALID_ENTRY.handler,
              url: 'http://handler.internal/x',
            },
          },
        ],
      });
      expect(registration.handler.url).toBe('http://handler.internal/x');
    });
  });

  describe('rejections — each one is a boot failure', () => {
    const rejects = (config: unknown, message: RegExp) => {
      expect(() => {
        return parse(config);
      }).toThrow(message);
    };

    test('names the source file in every message', () => {
      rejects(
        { resource_types: 'nope' },
        /\/etc\/soat\/formation-resource-types\.json/
      );
    });

    test('rejects a non-object config', () => {
      rejects('nope', /must be a JSON object/);
    });

    test('rejects a missing or non-array resource_types', () => {
      rejects({}, /`resource_types` must be an array/);
      rejects({ resource_types: {} }, /`resource_types` must be an array/);
    });

    test('rejects a non-object entry', () => {
      rejects({ resource_types: ['channel'] }, /must be an object/);
    });

    test('rejects a missing or malformed name', () => {
      const { name: _dropped, ...noName } = VALID_ENTRY;
      rejects({ resource_types: [noName] }, /`name` is required/);
      rejects(
        { resource_types: [{ ...VALID_ENTRY, name: 'Channel' }] },
        /`name` must match/
      );
      rejects(
        { resource_types: [{ ...VALID_ENTRY, name: 'my-channel' }] },
        /`name` must match/
      );
    });

    test('rejects a name that collides with a built-in resource type', () => {
      // Shadowing a built-in would let deployment config silently redirect an
      // `agent` resource to an external handler.
      rejects(
        { resource_types: [{ ...VALID_ENTRY, name: 'agent' }] },
        /'agent' is a built-in formation resource type/
      );
    });

    test('rejects a duplicate name within the file', () => {
      rejects(
        { resource_types: [VALID_ENTRY, VALID_ENTRY] },
        /declared more than once/
      );
    });

    test('rejects a missing handler block', () => {
      const { handler: _dropped, ...noHandler } = VALID_ENTRY;
      rejects({ resource_types: [noHandler] }, /`handler` must be an object/);
    });

    test('rejects a handler URL that is missing or not http\\(s\\)', () => {
      rejects(
        {
          resource_types: [
            {
              ...VALID_ENTRY,
              handler: { secret_env: 'CHANNEL_HANDLER_SECRET' },
            },
          ],
        },
        /`handler.url` must be an http\(s\) URL/
      );
      rejects(
        {
          resource_types: [
            {
              ...VALID_ENTRY,
              handler: { ...VALID_ENTRY.handler, url: 'ftp://handler/x' },
            },
          ],
        },
        /`handler.url` must be an http\(s\) URL/
      );
      rejects(
        {
          resource_types: [
            {
              ...VALID_ENTRY,
              handler: { ...VALID_ENTRY.handler, url: 'not a url' },
            },
          ],
        },
        /`handler.url` must be an http\(s\) URL/
      );
    });

    test('rejects a missing secret_env', () => {
      rejects(
        {
          resource_types: [
            { ...VALID_ENTRY, handler: { url: VALID_ENTRY.handler.url } },
          ],
        },
        /`handler.secret_env` must be a string/
      );
    });

    test('rejects a secret_env naming a variable that is unset or empty', () => {
      // Caught at boot rather than on the first apply, which would otherwise
      // sign every request with an empty key.
      rejects(
        {
          resource_types: [
            {
              ...VALID_ENTRY,
              handler: {
                ...VALID_ENTRY.handler,
                secret_env: 'NOT_SET_ANYWHERE',
              },
            },
          ],
        },
        /environment variable `NOT_SET_ANYWHERE` is not set/
      );
    });

    test('rejects a non-positive timeout', () => {
      rejects(
        {
          resource_types: [
            {
              ...VALID_ENTRY,
              handler: { ...VALID_ENTRY.handler, timeout_seconds: 0 },
            },
          ],
        },
        /`handler.timeout_seconds` must be a positive number/
      );
    });

    test('rejects an unknown capability', () => {
      rejects(
        {
          resource_types: [
            { ...VALID_ENTRY, capabilities: ['validate', 'teleport'] },
          ],
        },
        /Unknown capability 'teleport'/
      );
      rejects(
        { resource_types: [{ ...VALID_ENTRY, capabilities: 'validate' }] },
        /`capabilities` must be an array/
      );
    });

    test('rejects a schema that is not an object schema with properties', () => {
      const { schema: _dropped, ...noSchema } = VALID_ENTRY;
      rejects(
        { resource_types: [noSchema] },
        /`schema` must be an object schema/
      );
      rejects(
        { resource_types: [{ ...VALID_ENTRY, schema: { type: 'object' } }] },
        /`schema` must be an object schema/
      );
    });
  });
});

// ── Loading the file the environment names ──────────────────────────────────

describe('loadFormationResourceTypeConfig', () => {
  let configPath: string;

  beforeAll(() => {
    configPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'soat-formation-types-')),
      'resource-types.json'
    );
  });

  const writeConfig = (config: unknown): void => {
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8');
  };

  test('returns nothing when no config file is named', () => {
    // The overwhelmingly common case: a deployment that registers no custom
    // types must behave exactly as it did before they existed.
    expect(
      loadFormationResourceTypeConfig({ builtInTypes: BUILT_INS, env: {} })
    ).toEqual([]);
  });

  test('reads, parses and validates the named file', () => {
    writeConfig({ resource_types: [VALID_ENTRY] });

    const registrations = loadFormationResourceTypeConfig({
      builtInTypes: BUILT_INS,
      env: { ...ENV, FORMATION_RESOURCE_TYPES_CONFIG: configPath },
    });

    expect(
      registrations.map((r) => {
        return r.name;
      })
    ).toEqual(['channel']);
  });

  test('a file that cannot be read is a boot failure naming the path', () => {
    const missing = path.join(path.dirname(configPath), 'does-not-exist.json');

    expect(() => {
      return loadFormationResourceTypeConfig({
        builtInTypes: BUILT_INS,
        env: { ...ENV, FORMATION_RESOURCE_TYPES_CONFIG: missing },
      });
    }).toThrow(/Could not read formation resource type config/);
  });

  test('a file that is not JSON is a boot failure naming the path', () => {
    fs.writeFileSync(configPath, '{ not json', 'utf-8');

    expect(() => {
      return loadFormationResourceTypeConfig({
        builtInTypes: BUILT_INS,
        env: { ...ENV, FORMATION_RESOURCE_TYPES_CONFIG: configPath },
      });
    }).toThrow(/Could not parse formation resource type config/);
  });

  test('a valid file registers its types into the live registry at boot', () => {
    writeConfig({ resource_types: [VALID_ENTRY] });
    const previous = process.env[FORMATION_RESOURCE_TYPES_CONFIG_ENV];
    process.env[FORMATION_RESOURCE_TYPES_CONFIG_ENV] = configPath;
    process.env.CHANNEL_HANDLER_SECRET = ENV.CHANNEL_HANDLER_SECRET;

    try {
      initFormationResourceTypes();
      expect(getFormationModule({ resourceType: 'channel' })).toBeDefined();
      expect(supportedResourceTypes().has('channel')).toBe(true);
    } finally {
      // A registry mutation must never leak into another test file
      // (`.claude/rules/tests.md` — no global singleton state).
      unregisterFormationResourceTypes({ names: ['channel'] });
      delete process.env.CHANNEL_HANDLER_SECRET;
      if (previous === undefined) {
        delete process.env[FORMATION_RESOURCE_TYPES_CONFIG_ENV];
      } else {
        process.env[FORMATION_RESOURCE_TYPES_CONFIG_ENV] = previous;
      }
    }

    expect(getFormationModule({ resourceType: 'channel' })).toBeUndefined();
  });

  test('unregistering never removes a built-in type', () => {
    unregisterFormationResourceTypes({ names: ['agent'] });
    expect(getFormationModule({ resourceType: 'agent' })).toBeDefined();
  });
});
