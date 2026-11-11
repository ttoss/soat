import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  IAM_REGISTRATIONS_CONFIG_ENV,
  loadIamRegistrationConfig,
  parseIamRegistrationConfig,
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
