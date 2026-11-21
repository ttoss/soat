import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  FORMATION_RESOURCE_TYPES_CONFIG_ENV,
  parseFormationResourceTypeConfig,
} from 'src/lib/formationResourceTypeConfig';
import {
  loadFormationResourceTypeConfig,
  parseDisabledResourceTypes,
} from 'src/lib/formationResourceTypeConfigFile';
import {
  disableFormationResourceTypes,
  enableFormationResourceTypes,
  getFormationModule,
  initFormationResourceTypes,
  registerFormationResourceTypes,
  supportedResourceTypes,
  unregisterFormationResourceTypes,
} from 'src/lib/formationsRegistry';

// Parsed once at boot, where every rejection is a hard failure that says nothing
// about which rule fired — a `lib/` test per the keep-list rule.

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
  // Built-in actions, so the registry's `iam/check` test passes without a
  // registered IAM module.
  writer: {
    resource_type: 'webhook',
    create: 'webhooks:CreateWebhook',
    update: 'webhooks:UpdateWebhook',
    delete: 'webhooks:DeleteWebhook',
    carries: [
      {
        property: 'agent_id',
        action: 'agents:CreateAgentGeneration',
        resource_type: 'agent',
      },
    ],
  },
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

    test('write_only_properties are collected, and default to none', () => {
      const [none] = parse({ resource_types: [VALID_ENTRY] });
      expect(none.writeOnlyProperties.size).toBe(0);

      const [declared] = parse({
        resource_types: [
          { ...VALID_ENTRY, write_only_properties: ['agent_id'] },
        ],
      });
      expect([...declared.writeOnlyProperties]).toEqual(['agent_id']);
    });

    test('a built-in name is accepted when the entry says it overrides it', () => {
      const [registration] = parse({
        resource_types: [
          { ...VALID_ENTRY, name: 'agent', overrides_builtin: true },
        ],
      });
      expect(registration.name).toBe('agent');
      expect(registration.overridesBuiltin).toBe(true);
    });

    test('overrides_builtin defaults to false', () => {
      const [registration] = parse({ resource_types: [VALID_ENTRY] });
      expect(registration.overridesBuiltin).toBe(false);
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
        /'agent' is a built-in formation resource type.*`overrides_builtin: true`/
      );
    });

    test('rejects overrides_builtin on a name that is not a built-in', () => {
      // A typo in the name would otherwise register an unrelated type while the
      // built-in it meant to replace kept running.
      rejects(
        { resource_types: [{ ...VALID_ENTRY, overrides_builtin: true }] },
        /'channel' is not a built-in formation resource type/
      );
    });

    test('rejects an overrides_builtin that is not a boolean', () => {
      rejects(
        {
          resource_types: [
            { ...VALID_ENTRY, name: 'agent', overrides_builtin: 'yes' },
          ],
        },
        /`overrides_builtin` must be a boolean/
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

    test('rejects write_only_properties that is not an array of strings', () => {
      rejects(
        { resource_types: [{ ...VALID_ENTRY, write_only_properties: 'kind' }] },
        /`write_only_properties` must be an array of strings/
      );
      rejects(
        { resource_types: [{ ...VALID_ENTRY, write_only_properties: [1] }] },
        /`write_only_properties` must be an array of strings/
      );
    });

    test('rejects a write-only property the schema does not declare', () => {
      // A typo here would silently protect nothing — the credential it was
      // meant to strip would be stored in full.
      rejects(
        {
          resource_types: [
            { ...VALID_ENTRY, write_only_properties: ['acces_token'] },
          ],
        },
        /`write_only_properties` names 'acces_token', which the schema does not declare/
      );
    });

    test('reads the writer declaration', () => {
      const [registration] = parse({ resource_types: [VALID_ENTRY] });
      expect(registration.writer).toEqual({
        resourceType: 'webhook',
        actions: {
          create: 'webhooks:CreateWebhook',
          update: 'webhooks:UpdateWebhook',
          delete: 'webhooks:DeleteWebhook',
        },
        carries: [
          {
            property: 'agent_id',
            action: 'agents:CreateAgentGeneration',
            resourceType: 'agent',
          },
        ],
      });
    });

    test('rejects an entry without a writer declaration', () => {
      const { writer: _dropped, ...noWriter } = VALID_ENTRY;
      rejects({ resource_types: [noWriter] }, /`writer` is required/);
    });

    test('rejects a lifecycle action that is not <module>:<Operation>', () => {
      rejects(
        {
          resource_types: [
            {
              ...VALID_ENTRY,
              writer: { ...VALID_ENTRY.writer, update: 'Update' },
            },
          ],
        },
        /`writer.update` must be an IAM action/
      );
    });

    test('rejects a carried property the schema does not declare', () => {
      rejects(
        {
          resource_types: [
            {
              ...VALID_ENTRY,
              writer: {
                ...VALID_ENTRY.writer,
                carries: [
                  {
                    property: 'default.agent_id',
                    action: 'agents:CreateAgentGeneration',
                    resource_type: 'agent',
                  },
                ],
              },
            },
          ],
        },
        /names 'default', which the schema does not declare/
      );
    });

    const withKeyedCarries = (byValue: unknown) => {
      return {
        resource_types: [
          {
            ...VALID_ENTRY,
            writer: {
              ...VALID_ENTRY.writer,
              carries: [{ property: 'kind', by_value: byValue }],
            },
          },
        ],
      };
    };

    test('reads a carried property keyed by value', () => {
      const [registration] = parse(
        withKeyedCarries({
          whatsapp: [{ action: 'agents:GetAgent', resource_type: 'agent' }],
          email: [],
        })
      );
      expect(registration.writer.carries).toEqual([
        {
          property: 'kind',
          byValue: new Map([
            [
              'whatsapp',
              [{ action: 'agents:GetAgent', resourceType: 'agent' }],
            ],
            ['email', []],
          ]),
        },
      ]);
    });

    test('reads a keyed action on the whole project as resource type `*`', () => {
      const [registration] = parse(
        withKeyedCarries({
          project: [{ action: 'projects:GetProject', resource_type: '*' }],
        })
      );
      expect(registration.writer.carries).toEqual([
        {
          property: 'kind',
          byValue: new Map([
            ['project', [{ action: 'projects:GetProject', resourceType: '*' }]],
          ]),
        },
      ]);
    });

    test('accepts `*` only on a keyed action', () => {
      rejects(
        {
          resource_types: [
            {
              ...VALID_ENTRY,
              writer: { ...VALID_ENTRY.writer, resource_type: '*' },
            },
          ],
        },
        /`writer.resource_type` must be an SRN resource type/
      );
      rejects(
        {
          resource_types: [
            {
              ...VALID_ENTRY,
              writer: {
                ...VALID_ENTRY.writer,
                carries: [
                  {
                    property: 'kind',
                    action: 'projects:GetProject',
                    resource_type: '*',
                  },
                ],
              },
            },
          ],
        },
        /`writer.carries\[0\]`.resource_type must be an SRN resource type/
      );
    });

    test('rejects a keyed carry with no values or a malformed entry', () => {
      rejects(withKeyedCarries({}), /`writer.carries\[0\]`.by_value must map/);
      rejects(
        withKeyedCarries({ whatsapp: { action: 'agents:GetAgent' } }),
        /`writer.carries\[0\]`.by_value.whatsapp must be an array/
      );
      rejects(
        withKeyedCarries({
          whatsapp: [{ action: 'GetAgent', resource_type: 'agent' }],
        }),
        /`writer.carries\[0\]`.by_value.whatsapp\[0\].action must be an IAM action/
      );
    });

    test('rejects a carry declaring both an action and by_value', () => {
      rejects(
        {
          resource_types: [
            {
              ...VALID_ENTRY,
              writer: {
                ...VALID_ENTRY.writer,
                carries: [
                  {
                    property: 'kind',
                    action: 'agents:GetAgent',
                    resource_type: 'agent',
                    by_value: {},
                  },
                ],
              },
            },
          ],
        },
        /`writer.carries\[0\]` declares either `action` and `resource_type` or `by_value`/
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
    // types runs on the built-in resource types alone.
    expect(
      loadFormationResourceTypeConfig({ builtInTypes: BUILT_INS, env: {} })
    ).toEqual({ registrations: [], disabledTypes: new Set() });
  });

  test('reads, parses and validates the named file', () => {
    writeConfig({ resource_types: [VALID_ENTRY] });

    const { registrations, disabledTypes } = loadFormationResourceTypeConfig({
      builtInTypes: BUILT_INS,
      env: { ...ENV, FORMATION_RESOURCE_TYPES_CONFIG: configPath },
    });

    expect(
      registrations.map((r) => {
        return r.name;
      })
    ).toEqual(['channel']);
    expect(disabledTypes).toEqual(new Set());
  });

  test('reads an entry that overrides a built-in', () => {
    writeConfig({
      resource_types: [
        { ...VALID_ENTRY, name: 'agent', overrides_builtin: true },
      ],
    });

    const {
      registrations: [registration],
    } = loadFormationResourceTypeConfig({
      builtInTypes: BUILT_INS,
      env: { ...ENV, FORMATION_RESOURCE_TYPES_CONFIG: configPath },
    });

    expect(registration.overridesBuiltin).toBe(true);
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

  test('reads the built-ins the file disables', () => {
    writeConfig({
      resource_types: [VALID_ENTRY],
      disabled_resource_types: ['tool'],
    });

    const { disabledTypes } = loadFormationResourceTypeConfig({
      builtInTypes: BUILT_INS,
      env: { ...ENV, FORMATION_RESOURCE_TYPES_CONFIG: configPath },
    });

    expect(disabledTypes).toEqual(new Set(['tool']));
  });

  test('a valid file disables its types in the live registry at boot', () => {
    writeConfig({ resource_types: [], disabled_resource_types: ['chat'] });
    const previous = process.env[FORMATION_RESOURCE_TYPES_CONFIG_ENV];
    process.env[FORMATION_RESOURCE_TYPES_CONFIG_ENV] = configPath;

    try {
      initFormationResourceTypes();
      expect(supportedResourceTypes().has('chat')).toBe(false);
      expect(getFormationModule({ resourceType: 'chat' })).toBeDefined();
    } finally {
      enableFormationResourceTypes({ names: ['chat'] });
      if (previous === undefined) {
        delete process.env[FORMATION_RESOURCE_TYPES_CONFIG_ENV];
      } else {
        process.env[FORMATION_RESOURCE_TYPES_CONFIG_ENV] = previous;
      }
    }

    expect(supportedResourceTypes().has('chat')).toBe(true);
  });

  test('unregistering never removes a built-in type', () => {
    unregisterFormationResourceTypes({ names: ['agent'] });
    expect(getFormationModule({ resourceType: 'agent' })).toBeDefined();
  });
});

// ── Overriding a built-in ───────────────────────────────────────────────────

const webhookOverride = () => {
  return parseFormationResourceTypeConfig({
    config: {
      resource_types: [
        { ...VALID_ENTRY, name: 'webhook', overrides_builtin: true },
      ],
    },
    builtInTypes: new Set(['webhook']),
    env: ENV,
    source: 'test',
  })[0];
};

describe('registerFormationResourceTypes — overriding a built-in', () => {
  test('replaces the built-in module, and unregistering restores it', () => {
    const builtIn = getFormationModule({ resourceType: 'webhook' });
    expect(builtIn?.authorization).not.toHaveProperty('operatorRegistered');

    try {
      registerFormationResourceTypes({ registrations: [webhookOverride()] });
      expect(getFormationModule({ resourceType: 'webhook' })).toMatchObject({
        authorization: { operatorRegistered: true },
      });
    } finally {
      unregisterFormationResourceTypes({ names: ['webhook'] });
    }

    expect(getFormationModule({ resourceType: 'webhook' })).toBe(builtIn);
  });

  test('a writer action `iam/check` does not answer on its type is refused', () => {
    const registration = webhookOverride();
    expect(() => {
      registerFormationResourceTypes({
        registrations: [
          {
            ...registration,
            writer: { ...registration.writer, resourceType: 'agent' },
          },
        ],
      });
    }).toThrow(/declares webhooks:CreateWebhook on 'agent'/);
    expect(
      getFormationModule({ resourceType: 'webhook' })?.authorization
    ).not.toHaveProperty('operatorRegistered');
  });

  const keyedOn = (
    actions: Array<{ action: string; resourceType: string }>
  ) => {
    const registration = webhookOverride();
    return {
      ...registration,
      writer: {
        ...registration.writer,
        carries: [{ property: 'kind', byValue: new Map([['k', actions]]) }],
      },
    };
  };

  test('a keyed project-wide action boots', () => {
    try {
      registerFormationResourceTypes({
        registrations: [
          keyedOn([{ action: 'projects:GetProject', resourceType: '*' }]),
        ],
      });
      expect(
        getFormationModule({ resourceType: 'webhook' })?.authorization
      ).toHaveProperty('operatorRegistered', true);
    } finally {
      unregisterFormationResourceTypes({ names: ['webhook'] });
    }
  });

  test.each([
    ['a typed action', 'agents:GetAgent'],
    ['an admin-gated action', 'users:GetUser'],
  ])('%s on the whole project is refused', (_label, action) => {
    expect(() => {
      registerFormationResourceTypes({
        registrations: [keyedOn([{ action, resourceType: '*' }])],
      });
    }).toThrow(`declares ${action} on '*'`);
  });

  test('an override of a name no built-in has is refused by the registry', () => {
    expect(() => {
      registerFormationResourceTypes({
        registrations: [{ ...webhookOverride(), name: 'not_a_builtin' }],
      });
    }).toThrow(/'not_a_builtin': it is not a built-in type/);
    expect(
      getFormationModule({ resourceType: 'not_a_builtin' })
    ).toBeUndefined();
  });
});

// ── Disabling built-in types ────────────────────────────────────────────────

describe('parseDisabledResourceTypes', () => {
  const parseDisabled = (config: unknown) => {
    return parseDisabledResourceTypes({
      config,
      builtInTypes: BUILT_INS,
      registrations: parse({ resource_types: [VALID_ENTRY] }),
      source: '/etc/soat/formation-resource-types.json',
    });
  };

  test('absent disables nothing', () => {
    expect(parseDisabled({ resource_types: [] })).toEqual(new Set());
  });

  test('returns the built-ins named', () => {
    expect(
      parseDisabled({ disabled_resource_types: ['agent', 'tool'] })
    ).toEqual(new Set(['agent', 'tool']));
  });

  test('rejects a value that is not an array of strings', () => {
    for (const value of ['agent', [1], {}]) {
      expect(() => {
        return parseDisabled({ disabled_resource_types: value });
      }).toThrow(/`disabled_resource_types` must be an array of strings/);
    }
  });

  test('rejects a name that is not a built-in', () => {
    expect(() => {
      return parseDisabled({ disabled_resource_types: ['widget'] });
    }).toThrow(/'widget' is not a built-in type/);
  });

  test('rejects a type the same file registers', () => {
    const registrations = parse({
      resource_types: [
        { ...VALID_ENTRY, name: 'agent', overrides_builtin: true },
      ],
    });
    expect(() => {
      return parseDisabledResourceTypes({
        config: { disabled_resource_types: ['agent'] },
        builtInTypes: BUILT_INS,
        registrations,
        source: 'cfg.json',
      });
    }).toThrow(/'agent' is also registered in `resource_types`/);
  });

  test('rejects a name listed twice', () => {
    expect(() => {
      return parseDisabled({ disabled_resource_types: ['tool', 'tool'] });
    }).toThrow(/'tool' is listed twice/);
  });
});

describe('disableFormationResourceTypes', () => {
  afterEach(() => {
    enableFormationResourceTypes({ names: ['chat', 'webhook'] });
    unregisterFormationResourceTypes({ names: ['webhook', 'channel'] });
  });

  test('a disabled built-in leaves the declarable set, not the registry', () => {
    disableFormationResourceTypes({ names: ['chat'] });

    expect(supportedResourceTypes().has('chat')).toBe(false);
    expect(supportedResourceTypes().has('agent')).toBe(true);
    expect(getFormationModule({ resourceType: 'chat' })).toBeDefined();
  });

  test('refuses a type that is not a built-in', () => {
    expect(() => {
      disableFormationResourceTypes({ names: ['not_a_builtin'] });
    }).toThrow(/Cannot disable formation resource type 'not_a_builtin'/);
  });

  test('refuses a built-in a registration overrides', () => {
    registerFormationResourceTypes({ registrations: [webhookOverride()] });

    expect(() => {
      disableFormationResourceTypes({ names: ['webhook'] });
    }).toThrow(/Cannot disable formation resource type 'webhook'/);
  });

  test('refuses to register over a disabled type', () => {
    disableFormationResourceTypes({ names: ['webhook'] });

    expect(() => {
      registerFormationResourceTypes({ registrations: [webhookOverride()] });
    }).toThrow(/the deployment disables it/);
  });
});
