import { Op } from '@ttoss/postgresdb';
import {
  compilePolicy,
  globToLike,
  registerResourceFieldMap,
} from 'src/lib/policyCompiler';

// Register test resource type (persists in module-level Map across all tests)
registerResourceFieldMap({
  resourceType: 'testResource',
  publicIdColumn: { column: 'publicId' },
  pathColumn: { column: 'path' },
  tagsColumn: { column: 'tags' },
});

// A resource type whose columns live on an associated (joined) model, so
// colRef renders `$file.<column>$` references — exercises the alias branches.
registerResourceFieldMap({
  resourceType: 'aliasedResource',
  publicIdColumn: { column: 'publicId', alias: 'file' },
  pathColumn: { column: 'path', alias: 'file' },
  tagsColumn: { column: 'tags', alias: 'file' },
});

describe('globToLike', () => {
  test('replaces * with %', () => {
    expect(globToLike('foo*bar')).toBe('foo%bar');
  });

  test('replaces ? with _', () => {
    expect(globToLike('foo?bar')).toBe('foo_bar');
  });

  test('escapes literal %', () => {
    expect(globToLike('foo%bar')).toBe('foo\\%bar');
  });

  test('escapes literal _', () => {
    expect(globToLike('foo_bar')).toBe('foo\\_bar');
  });

  test('handles combined glob patterns', () => {
    expect(globToLike('/docs/*.txt')).toBe('/docs/%.txt');
  });

  test('handles multiple wildcards', () => {
    expect(globToLike('*/*')).toBe('%/%');
  });

  test('returns unchanged string when no special chars', () => {
    expect(globToLike('hello')).toBe('hello');
  });
});

describe('compilePolicy', () => {
  test('throws when resourceType is not registered', () => {
    expect(() => {
      return compilePolicy({
        policies: [],
        action: 'test:Do',
        resourceType: 'notRegistered',
        projectPublicId: 'prj_1',
      });
    }).toThrow(
      "No ResourceFieldMap registered for resourceType 'notRegistered'"
    );
  });

  test('returns hasAccess false when no policies provided', () => {
    const result = compilePolicy({
      policies: [],
      action: 'test:Do',
      resourceType: 'testResource',
      projectPublicId: 'prj_1',
    });
    expect(result.hasAccess).toBe(false);
    expect(result.where).toEqual({});
  });

  test('returns hasAccess false when action does not match', () => {
    const result = compilePolicy({
      policies: [
        {
          statement: [
            { effect: 'Allow', action: ['test:Other'], resource: ['*'] },
          ],
        },
      ],
      action: 'test:Do',
      resourceType: 'testResource',
      projectPublicId: 'prj_1',
    });
    expect(result.hasAccess).toBe(false);
  });

  test('Allow all (resource=*) returns hasAccess true with empty where', () => {
    const result = compilePolicy({
      policies: [
        {
          statement: [
            { effect: 'Allow', action: ['test:Do'], resource: ['*'] },
          ],
        },
      ],
      action: 'test:Do',
      resourceType: 'testResource',
      projectPublicId: 'prj_1',
    });
    expect(result.hasAccess).toBe(true);
    expect(result.where).toEqual({});
  });

  test('Deny all immediately returns hasAccess false', () => {
    const result = compilePolicy({
      policies: [
        {
          statement: [
            { effect: 'Allow', action: ['test:Do'], resource: ['*'] },
          ],
        },

        {
          statement: [{ effect: 'Deny', action: ['test:Do'], resource: ['*'] }],
        },
      ],
      action: 'test:Do',
      resourceType: 'testResource',
      projectPublicId: 'prj_1',
    });
    expect(result.hasAccess).toBe(false);
  });

  test('Allow specific resource ID builds where clause', () => {
    const result = compilePolicy({
      policies: [
        {
          statement: [
            {
              effect: 'Allow',
              action: ['test:Do'],
              resource: ['soat:prj_1:testResource:res_abc123'],
            },
          ],
        },
      ],
      action: 'test:Do',
      resourceType: 'testResource',
      projectPublicId: 'prj_1',
    });
    expect(result.hasAccess).toBe(true);
    expect(result.where).toEqual({
      [Op.and]: [{ [Op.or]: [{ [Op.and]: [{ publicId: 'res_abc123' }] }] }],
    });
  });

  test('Allow glob resource builds LIKE where clause', () => {
    const result = compilePolicy({
      policies: [
        {
          statement: [
            {
              effect: 'Allow',
              action: ['test:Do'],
              resource: ['soat:prj_1:testResource:res_*'],
            },
          ],
        },
      ],
      action: 'test:Do',
      resourceType: 'testResource',
      projectPublicId: 'prj_1',
    });
    expect(result.hasAccess).toBe(true);
    expect(result.where).toEqual({
      [Op.and]: [
        {
          [Op.or]: [{ [Op.and]: [{ publicId: { [Op.like]: 'res\\_%' } }] }],
        },
      ],
    });
  });

  test('Allow with StringEquals tag condition builds where clause', () => {
    const result = compilePolicy({
      policies: [
        {
          statement: [
            {
              effect: 'Allow',
              action: ['test:Do'],
              resource: ['*'],
              condition: {
                StringEquals: { 'soat:ResourceTag/env': 'production' },
              },
            },
          ],
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any,
      action: 'test:Do',
      resourceType: 'testResource',
      projectPublicId: 'prj_1',
    });
    expect(result.hasAccess).toBe(true);
    expect(result.where).toEqual({
      [Op.and]: [
        {
          [Op.or]: [
            {
              [Op.and]: [{ tags: { [Op.contains]: { env: 'production' } } }],
            },
          ],
        },
      ],
    });
  });

  test('Allow with StringNotEquals tag condition builds where clause', () => {
    const result = compilePolicy({
      policies: [
        {
          statement: [
            {
              effect: 'Allow',
              action: ['test:Do'],
              resource: ['*'],
              condition: {
                StringNotEquals: { 'soat:ResourceTag/env': 'dev' },
              },
            },
          ],
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any,
      action: 'test:Do',
      resourceType: 'testResource',
      projectPublicId: 'prj_1',
    });
    expect(result.hasAccess).toBe(true);
  });

  test('Allow with StringLike tag condition builds where clause', () => {
    const result = compilePolicy({
      policies: [
        {
          statement: [
            {
              effect: 'Allow',
              action: ['test:Do'],
              resource: ['*'],
              condition: {
                StringLike: { 'soat:ResourceTag/env': 'prod*' },
              },
            },
          ],
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any,
      action: 'test:Do',
      resourceType: 'testResource',
      projectPublicId: 'prj_1',
    });
    expect(result.hasAccess).toBe(true);
  });

  test('Allow path-based resource builds path where clause', () => {
    const result = compilePolicy({
      policies: [
        {
          statement: [
            {
              effect: 'Allow',
              action: ['test:Do'],
              resource: ['soat:prj_1:testResource:/docs/readme.txt'],
            },
          ],
        },
      ],
      action: 'test:Do',
      resourceType: 'testResource',
      projectPublicId: 'prj_1',
    });
    expect(result.hasAccess).toBe(true);
    expect(result.where).toEqual({
      [Op.and]: [{ [Op.or]: [{ [Op.and]: [{ path: '/docs/readme.txt' }] }] }],
    });
  });

  test('Deny specific resource adds NOT condition', () => {
    const result = compilePolicy({
      policies: [
        {
          statement: [
            { effect: 'Allow', action: ['test:Do'], resource: ['*'] },
            {
              effect: 'Deny',
              action: ['test:Do'],
              resource: ['soat:prj_1:testResource:res_secret'],
            },
          ],
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any,
      action: 'test:Do',
      resourceType: 'testResource',
      projectPublicId: 'prj_1',
    });
    expect(result.hasAccess).toBe(true);
    expect(result.where).toEqual({
      [Op.and]: [
        {
          [Op.not]: {
            [Op.or]: [{ [Op.and]: [{ publicId: 'res_secret' }] }],
          },
        },
      ],
    });
  });

  test('wildcard action (*) matches any action', () => {
    const result = compilePolicy({
      policies: [
        { statement: [{ effect: 'Allow', action: ['*'], resource: ['*'] }] },
      ],
      action: 'test:AnyAction',
      resourceType: 'testResource',
      projectPublicId: 'prj_1',
    });
    expect(result.hasAccess).toBe(true);
  });

  test('Allow with multiple resources OR-combines them', () => {
    const result = compilePolicy({
      policies: [
        {
          statement: [
            {
              effect: 'Allow',
              action: ['test:Do'],
              resource: [
                'soat:prj_1:testResource:res_abc',
                'soat:prj_1:testResource:res_xyz',
              ],
            },
          ],
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any,
      action: 'test:Do',
      resourceType: 'testResource',
      projectPublicId: 'prj_1',
    });
    expect(result.hasAccess).toBe(true);
    expect(result.where).toEqual({
      [Op.and]: [
        {
          [Op.or]: [
            {
              [Op.and]: [
                {
                  [Op.or]: [{ publicId: 'res_abc' }, { publicId: 'res_xyz' }],
                },
              ],
            },
          ],
        },
      ],
    });
  });

  test('glob path resource builds LIKE where clause', () => {
    const result = compilePolicy({
      policies: [
        {
          statement: [
            {
              effect: 'Allow',
              action: ['test:Do'],
              resource: ['soat:prj_1:testResource:/docs/*'],
            },
          ],
        },
      ],
      action: 'test:Do',
      resourceType: 'testResource',
      projectPublicId: 'prj_1',
    });
    expect(result.hasAccess).toBe(true);
    expect(result.where).toEqual({
      [Op.and]: [
        {
          [Op.or]: [{ [Op.and]: [{ path: { [Op.like]: '/docs/%' } }] }],
        },
      ],
    });
  });

  test('aliased resource column renders $alias.column$ reference', () => {
    const result = compilePolicy({
      policies: [
        {
          statement: [
            {
              effect: 'Allow',
              action: ['test:Do'],
              resource: ['soat:prj_1:aliasedResource:res_abc'],
            },
          ],
        },
      ],
      action: 'test:Do',
      resourceType: 'aliasedResource',
      projectPublicId: 'prj_1',
    });
    expect(result.hasAccess).toBe(true);
    expect(result.where).toEqual({
      [Op.and]: [
        { [Op.or]: [{ [Op.and]: [{ '$file.publicId$': 'res_abc' }] }] },
      ],
    });
  });

  test('aliased tags column compiles a StringLike condition', () => {
    const result = compilePolicy({
      policies: [
        {
          statement: [
            {
              effect: 'Allow',
              action: ['test:Do'],
              resource: ['*'],
              condition: { StringLike: { 'soat:ResourceTag/env': 'prod*' } },
            },
          ],
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any,
      action: 'test:Do',
      resourceType: 'aliasedResource',
      projectPublicId: 'prj_1',
    });
    expect(result.hasAccess).toBe(true);
  });

  test('StringLike with an unsafe tag key is skipped', () => {
    const result = compilePolicy({
      policies: [
        {
          statement: [
            {
              effect: 'Allow',
              action: ['test:Do'],
              resource: ['*'],
              // The key after the prefix contains a space → rejected as unsafe.
              condition: { StringLike: { 'soat:ResourceTag/bad key': 'x*' } },
            },
          ],
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any,
      action: 'test:Do',
      resourceType: 'testResource',
      projectPublicId: 'prj_1',
    });
    // No tag fragment was produced, so the '*' resource makes it an allow-all.
    expect(result.hasAccess).toBe(true);
    expect(result.where).toEqual({});
  });

  test('unrecognized condition operator produces no fragments', () => {
    const result = compilePolicy({
      policies: [
        {
          statement: [
            {
              effect: 'Allow',
              action: ['test:Do'],
              resource: ['*'],
              condition: { NumericEquals: { 'soat:ResourceTag/count': '1' } },
            },
          ],
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any,
      action: 'test:Do',
      resourceType: 'testResource',
      projectPublicId: 'prj_1',
    });
    expect(result.hasAccess).toBe(true);
    expect(result.where).toEqual({});
  });

  test('falsy condition block is skipped', () => {
    const result = compilePolicy({
      policies: [
        {
          statement: [
            {
              effect: 'Allow',
              action: ['test:Do'],
              resource: ['*'],
              condition: { StringEquals: null },
            },
          ],
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any,
      action: 'test:Do',
      resourceType: 'testResource',
      projectPublicId: 'prj_1',
    });
    expect(result.hasAccess).toBe(true);
    expect(result.where).toEqual({});
  });

  test('condition key that is not a ResourceTag key is skipped', () => {
    const result = compilePolicy({
      policies: [
        {
          statement: [
            {
              effect: 'Allow',
              action: ['test:Do'],
              resource: ['*'],
              condition: { StringEquals: { 'soat:CurrentTime': 'noon' } },
            },
          ],
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any,
      action: 'test:Do',
      resourceType: 'testResource',
      projectPublicId: 'prj_1',
    });
    expect(result.hasAccess).toBe(true);
    expect(result.where).toEqual({});
  });

  test('SRN with fewer than 4 segments is treated as unrestricted', () => {
    const result = compilePolicy({
      policies: [
        {
          statement: [
            {
              effect: 'Allow',
              action: ['test:Do'],
              resource: ['soat:prj_1:testResource'],
            },
          ],
        },
      ],
      action: 'test:Do',
      resourceType: 'testResource',
      projectPublicId: 'prj_1',
    });
    expect(result.hasAccess).toBe(true);
    expect(result.where).toEqual({});
  });

  test('empty resource array with a tag condition yields only tag fragments', () => {
    const result = compilePolicy({
      policies: [
        {
          statement: [
            {
              effect: 'Allow',
              action: ['test:Do'],
              resource: [],
              condition: { StringEquals: { 'soat:ResourceTag/env': 'prod' } },
            },
          ],
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any,
      action: 'test:Do',
      resourceType: 'testResource',
      projectPublicId: 'prj_1',
    });
    expect(result.hasAccess).toBe(true);
    expect(result.where).toEqual({
      [Op.and]: [
        {
          [Op.or]: [
            { [Op.and]: [{ tags: { [Op.contains]: { env: 'prod' } } }] },
          ],
        },
      ],
    });
  });

  test('Deny with an empty resource array and no condition adds an empty NOT', () => {
    const result = compilePolicy({
      policies: [
        {
          statement: [
            { effect: 'Allow', action: ['test:Do'], resource: ['*'] },
            { effect: 'Deny', action: ['test:Do'], resource: [] },
          ],
        },
      ],
      action: 'test:Do',
      resourceType: 'testResource',
      projectPublicId: 'prj_1',
    });
    expect(result.hasAccess).toBe(true);
    expect(result.where).toEqual({
      [Op.and]: [{ [Op.not]: { [Op.or]: [{}] } }],
    });
  });
});
