import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  declareDenialCodes,
  isDeclaredDenialCode,
  parseDenialCodes,
} from 'src/errors';
import {
  IAM_REGISTRATIONS_CONFIG_ENV,
  initIamRegistrations,
  isRegisteredIamModule,
  loadIamRegistrationConfig,
  parseIamRegistrationConfig,
  unregisterIamModules,
} from 'src/lib/iamRegistrations';

// Parsed once at boot, where every rejection is a hard failure: a `lib/` test
// per the keep-list rule.

const CHANNELS = {
  module: 'channels',
  resource_types: ['channel'],
  actions: [{ action: 'channels:CreateChannel', description: 'Create one' }],
};

const parse = (modules: unknown[]) => {
  return parseIamRegistrationConfig({ config: { modules }, source: 'cfg' });
};

describe('parseIamRegistrationConfig', () => {
  test('returns one registration per module', () => {
    const [registration] = parse([CHANNELS]);

    expect(registration.module).toBe('channels');
    expect([...registration.resourceTypes]).toEqual(['channel']);
    expect(registration.actions.get('channels:CreateChannel')).toBe(
      'Create one'
    );
  });

  test.each<[string, unknown]>([
    ['config without modules', {}],
    ['modules not an array', { modules: {} }],
  ])('rejects a %s', (_label, config) => {
    expect(() => {
      return parseIamRegistrationConfig({ config, source: 'cfg' });
    }).toThrow('`modules` must be an array');
  });

  test.each<[string, unknown[], string]>([
    ['a bad module name', [{ ...CHANNELS, module: 'Chan' }], '`module`'],
    [
      'a built-in module name',
      [{ ...CHANNELS, module: 'secrets', actions: [] }],
      'a built-in module',
    ],
    ['a duplicate module', [CHANNELS, CHANNELS], 'already declared'],
    [
      'missing resource types',
      [{ ...CHANNELS, resource_types: [] }],
      '`resource_types`',
    ],
    [
      'a bad resource type',
      [{ ...CHANNELS, resource_types: ['Channel'] }],
      "resource type 'Channel'",
    ],
    [
      'a resource type another module registered',
      [
        CHANNELS,
        {
          module: 'addresses',
          resource_types: ['channel'],
          actions: [{ action: 'addresses:GetAddress' }],
        },
      ],
      "already registered by 'channels'",
    ],
    ['missing actions', [{ ...CHANNELS, actions: [] }], '`actions`'],
    [
      'an action of another module',
      [{ ...CHANNELS, actions: [{ action: 'secrets:GetSecret' }] }],
      'must be channels:<Operation>',
    ],
    [
      'a wildcard action',
      [{ ...CHANNELS, actions: [{ action: 'channels:*' }] }],
      'must be channels:<Operation>',
    ],
    [
      'a duplicate action',
      [
        {
          ...CHANNELS,
          actions: [
            { action: 'channels:GetChannel' },
            { action: 'channels:GetChannel' },
          ],
        },
      ],
      'declared more than once',
    ],
  ])('rejects %s', (_label, modules, message) => {
    expect(() => {
      return parse(modules);
    }).toThrow(message);
  });
});

describe('project_group_actions', () => {
  const BILLING = {
    module: 'billing',
    project_group_actions: [
      {
        action: 'billing:TopUp',
        resource_types: ['top_up'],
        description: 'Top up the balance',
      },
      { action: 'billing:GetPlan', resource_types: ['*'] },
    ],
  };

  test('a module may declare project group actions alone', () => {
    const [registration] = parse([BILLING]);

    expect(registration.actions.size).toBe(0);
    expect(registration.resourceTypes.size).toBe(0);
    expect(registration.projectGroupActions.get('billing:TopUp')).toEqual({
      resourceTypes: new Set(['top_up']),
      description: 'Top up the balance',
    });
    expect(
      registration.projectGroupActions.get('billing:GetPlan')?.resourceTypes
    ).toEqual(new Set(['*']));
  });

  test('a module may declare both', () => {
    const [registration] = parse([
      {
        ...CHANNELS,
        project_group_actions: [
          { action: 'channels:ListGroupChannels', resource_types: ['channel'] },
        ],
      },
    ]);

    expect(registration.actions.has('channels:CreateChannel')).toBe(true);
    expect(
      registration.projectGroupActions.has('channels:ListGroupChannels')
    ).toBe(true);
  });

  test.each<[string, unknown[], string]>([
    [
      'a module declaring no action at all',
      [{ module: 'billing' }],
      '`actions` or `project_group_actions`',
    ],
    [
      'project group actions not an array',
      [{ ...BILLING, project_group_actions: {} }],
      '`project_group_actions` must be a non-empty array',
    ],
    [
      'the project group module',
      [{ ...BILLING, module: 'project-groups' }],
      'a built-in module',
    ],
    [
      'an action of another module',
      [
        {
          ...BILLING,
          project_group_actions: [
            {
              action: 'project-groups:CreateApiKey',
              resource_types: ['api_key'],
            },
          ],
        },
      ],
      'must be billing:<Operation>',
    ],
    [
      'an action without resource types',
      [
        {
          ...BILLING,
          project_group_actions: [{ action: 'billing:TopUp' }],
        },
      ],
      "action 'billing:TopUp': `resource_types` must be a non-empty array",
    ],
    [
      'a bad resource type',
      [
        {
          ...BILLING,
          project_group_actions: [
            { action: 'billing:TopUp', resource_types: ['TopUp'] },
          ],
        },
      ],
      "resource type 'TopUp'",
    ],
    [
      'a resource type a built-in project group action is checked on',
      [
        {
          ...BILLING,
          project_group_actions: [
            { action: 'billing:TopUp', resource_types: ['balance'] },
          ],
        },
      ],
      "resource type 'balance' is a built-in project group type",
    ],
    [
      'a project group resource type another module registered',
      [
        BILLING,
        {
          module: 'assistant',
          project_group_actions: [
            { action: 'assistant:CreateSession', resource_types: ['top_up'] },
          ],
        },
      ],
      "project group resource type 'top_up' is already registered by 'billing'",
    ],
    [
      'an action declared on both scopes',
      [
        {
          ...CHANNELS,
          project_group_actions: [
            { action: 'channels:CreateChannel', resource_types: ['channel'] },
          ],
        },
      ],
      'declared more than once',
    ],
  ])('rejects %s', (_label, modules, message) => {
    expect(() => {
      return parse(modules);
    }).toThrow(message);
  });
});

describe('loadIamRegistrationConfig', () => {
  test('returns nothing when the variable is unset', () => {
    expect(loadIamRegistrationConfig({ env: {} })).toEqual([]);
  });

  test('reads the file the variable names', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iam-reg-'));
    const file = path.join(dir, 'iam.json');
    fs.writeFileSync(file, JSON.stringify({ modules: [CHANNELS] }));

    const [registration] = loadIamRegistrationConfig({
      env: { [IAM_REGISTRATIONS_CONFIG_ENV]: file },
    });

    expect(registration.module).toBe('channels');
  });

  test('fails on a file that is not JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iam-reg-'));
    const file = path.join(dir, 'iam.json');
    fs.writeFileSync(file, '{');

    expect(() => {
      return loadIamRegistrationConfig({
        env: { [IAM_REGISTRATIONS_CONFIG_ENV]: file },
      });
    }).toThrow('Could not load IAM registrations config');
  });
});

describe('parseDenialCodes', () => {
  const parseCodes = (config: unknown) => {
    return parseDenialCodes({ config, source: 'cfg' });
  };

  test('returns each declared code with its hint', () => {
    const codes = parseCodes({
      denial_codes: [{ code: 'PLAN_REQUIRED', hint: 'Upgrade the plan.' }],
    });

    expect([...codes]).toEqual([['PLAN_REQUIRED', 'Upgrade the plan.']]);
  });

  test.each([null, {}])('declares nothing for %p', (config) => {
    expect(parseCodes(config).size).toBe(0);
  });

  test.each([
    [{ denial_codes: {} }, '`denial_codes` must be an array'],
    [{ denial_codes: ['X'] }, 'denial_codes[0] must be an object'],
    [{ denial_codes: [{ code: 'lower', hint: 'h' }] }, '.code must match'],
    [{ denial_codes: [{ hint: 'h' }] }, '.code must match'],
    [
      { denial_codes: [{ code: 'FORBIDDEN', hint: 'h' }] },
      "'FORBIDDEN' is already defined",
    ],
    [
      {
        denial_codes: [
          { code: 'PLAN_REQUIRED', hint: 'h' },
          { code: 'PLAN_REQUIRED', hint: 'h' },
        ],
      },
      "denial_codes[1].code 'PLAN_REQUIRED' is already defined",
    ],
    [
      { denial_codes: [{ code: 'PLAN_REQUIRED', hint: ' ' }] },
      '.hint must be a non-empty string',
    ],
    [
      { denial_codes: [{ code: 'PLAN_REQUIRED' }] },
      '.hint must be a non-empty string',
    ],
  ])('rejects %j', (config, message) => {
    expect(() => {
      return parseCodes(config);
    }).toThrow(message);
  });
});

describe('initIamRegistrations', () => {
  afterEach(() => {
    delete process.env[IAM_REGISTRATIONS_CONFIG_ENV];
    unregisterIamModules({ modules: ['channels'] });
    declareDenialCodes({ codes: new Map() });
  });

  test('registers the modules and denial codes the configured file declares', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iam-reg-'));
    const file = path.join(dir, 'iam.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        modules: [CHANNELS],
        denial_codes: [{ code: 'PLAN_REQUIRED', hint: 'Upgrade the plan.' }],
      })
    );
    process.env[IAM_REGISTRATIONS_CONFIG_ENV] = file;

    initIamRegistrations();

    expect(isRegisteredIamModule('channels')).toBe(true);
    expect(isDeclaredDenialCode('PLAN_REQUIRED')).toBe(true);
  });

  test('declares no denial code when no file is configured', () => {
    declareDenialCodes({ codes: new Map([['PLAN_REQUIRED', 'h']]) });

    initIamRegistrations();

    expect(isDeclaredDenialCode('PLAN_REQUIRED')).toBe(false);
  });
});
