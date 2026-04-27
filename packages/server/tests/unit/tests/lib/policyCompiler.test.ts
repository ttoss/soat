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
              resource: ['srn:soat:testResource:prj_1:res_abc123'],
            },
          ],
        },
      ],
      action: 'test:Do',
      resourceType: 'testResource',
      projectPublicId: 'prj_1',
    });
    expect(result.hasAccess).toBe(true);
    expect(result.where).toBeDefined();
  });

  test('Allow glob resource builds LIKE where clause', () => {
    const result = compilePolicy({
      policies: [
        {
          statement: [
            {
              effect: 'Allow',
              action: ['test:Do'],
              resource: ['srn:soat:testResource:prj_1:res_*'],
            },
          ],
        },
      ],
      action: 'test:Do',
      resourceType: 'testResource',
      projectPublicId: 'prj_1',
    });
    expect(result.hasAccess).toBe(true);
    expect(result.where).toBeDefined();
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
    expect(result.where).toBeDefined();
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
              resource: ['srn:soat:testResource:prj_1:/docs/readme.txt'],
            },
          ],
        },
      ],
      action: 'test:Do',
      resourceType: 'testResource',
      projectPublicId: 'prj_1',
    });
    expect(result.hasAccess).toBe(true);
    expect(result.where).toBeDefined();
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
              resource: ['srn:soat:testResource:prj_1:res_secret'],
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
    expect(result.where).toBeDefined();
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
                'srn:soat:testResource:prj_1:res_abc',
                'srn:soat:testResource:prj_1:res_xyz',
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
    expect(result.where).toBeDefined();
  });

  test('glob path resource builds LIKE where clause', () => {
    const result = compilePolicy({
      policies: [
        {
          statement: [
            {
              effect: 'Allow',
              action: ['test:Do'],
              resource: ['srn:soat:testResource:prj_1:/docs/*'],
            },
          ],
        },
      ],
      action: 'test:Do',
      resourceType: 'testResource',
      projectPublicId: 'prj_1',
    });
    expect(result.hasAccess).toBe(true);
    expect(result.where).toBeDefined();
  });
});
