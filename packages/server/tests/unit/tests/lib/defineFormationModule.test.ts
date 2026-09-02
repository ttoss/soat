import {
  defineFormationModule,
  schemaNameForResourceType,
} from 'src/lib/formation-modules/defineFormationModule';

// The mechanical half of a formation module used to be restated in all 24, which
// is what allowed #900 and #901. Now one implementation, tested once.
//
// A `lib/` test per the keep-list rule: pure validation over a large input
// space, where REST's bare "Unknown field" would not say which rule fired.
// `quota` carries it because its schema has required, nullable and three kinds
// of typed field, so the real derivation is exercised.

const BASE_PATH = 'resources.<quota>.properties';

const VALID_PROPERTIES = {
  scope: 'project',
  metric: 'tokens',
  window: 'rolling_24h',
  limit: 1000,
};

type QuotaRow = { scope: string; metric: string; extra: string };

const buildModule = (
  overrides: Partial<Parameters<typeof defineFormationModule<QuotaRow>>[0]> = {}
) => {
  return defineFormationModule<QuotaRow>({
    resourceType: 'quota',
    authorization: {
      srnResourceType: 'quota',
      create: 'quotas:CreateQuota',
      delete: 'quotas:DeleteQuota',
      // The factory refuses an update operation with no action to authorize it,
      // so the declaration follows whatever the override supplies.
      ...('update' in overrides ? { update: 'quotas:UpdateQuota' } : {}),
    },
    create: async () => {
      return { id: 'qta_created' };
    },
    remove: async () => {},
    ...overrides,
  });
};

describe('schemaNameForResourceType', () => {
  test('derives the PascalCase schema name from a snake_case type', () => {
    expect(schemaNameForResourceType('model_route')).toBe(
      'ModelRouteResourceProperties'
    );
    expect(schemaNameForResourceType('quota')).toBe('QuotaResourceProperties');
  });
});

describe('defineFormationModule — validateProperties', () => {
  test('rejects a non-object property bag with the resource prose', () => {
    const errors = buildModule().validateProperties!({
      properties: 'nope',
      basePath: BASE_PATH,
    });
    expect(errors).toEqual([
      { path: BASE_PATH, message: 'Quota `properties` must be an object' },
    ]);
  });

  test('uses an explicit propertiesLabel when the default is wrong', () => {
    const errors = buildModule({ propertiesLabel: 'AI provider' })
      .validateProperties!({ properties: [], basePath: BASE_PATH });
    expect(errors[0].message).toBe(
      'AI provider `properties` must be an object'
    );
  });

  test('reports an unknown field, naming the resource label', () => {
    const errors = buildModule().validateProperties!({
      properties: { ...VALID_PROPERTIES, nope: 1 },
      basePath: BASE_PATH,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe(`${BASE_PATH}.nope`);
    expect(errors[0].message).toMatch(/^Unknown quota field 'nope'\./);
  });

  test('reports a missing required field', () => {
    const errors = buildModule().validateProperties!({
      properties: { scope: 'project' },
      basePath: BASE_PATH,
    });
    expect(
      errors.map((error) => {
        return error.path;
      })
    ).toEqual([
      `${BASE_PATH}.metric`,
      `${BASE_PATH}.window`,
      `${BASE_PATH}.limit`,
    ]);
  });

  test('reports a wrong-typed field', () => {
    const errors = buildModule().validateProperties!({
      properties: { ...VALID_PROPERTIES, scope: 7 },
      basePath: BASE_PATH,
    });
    expect(errors).toEqual([
      { path: `${BASE_PATH}.scope`, message: '`scope` must be a string' },
    ]);
  });

  test('accepts a camelCase spelling without the module doing anything', () => {
    const errors = buildModule().validateProperties!({
      properties: { ...VALID_PROPERTIES, scopeRef: 'proj_1' },
      basePath: BASE_PATH,
    });
    expect(errors).toEqual([]);
  });

  test('runs extraChecks with the normalized bag and forUpdate=false', () => {
    const seen: Array<{ scopeRef: unknown; forUpdate: boolean }> = [];
    const errors = buildModule({
      extraChecks: ({ properties, basePath, forUpdate, errors: acc }) => {
        seen.push({ scopeRef: properties.scope_ref, forUpdate });
        acc.push({ path: basePath, message: 'extra check failed' });
      },
    }).validateProperties!({
      properties: { ...VALID_PROPERTIES, scopeRef: 'proj_1' },
      basePath: BASE_PATH,
    });

    expect(seen).toEqual([{ scopeRef: 'proj_1', forUpdate: false }]);
    expect(errors).toEqual([
      { path: BASE_PATH, message: 'extra check failed' },
    ]);
  });

  test('warnProperties is absent unless the module declares warnChecks', () => {
    expect(buildModule().warnProperties).toBeUndefined();
    const warned = buildModule({
      warnChecks: ({ properties, basePath }) => {
        return [{ path: basePath, message: `saw ${String(properties.scope)}` }];
      },
    }).warnProperties!({ properties: VALID_PROPERTIES, basePath: BASE_PATH });
    expect(warned).toEqual([{ path: BASE_PATH, message: 'saw project' }]);
  });

  test('warnChecks is skipped for a non-object bag', () => {
    const warned = buildModule({
      warnChecks: () => {
        return [{ path: BASE_PATH, message: 'should not run' }];
      },
    }).warnProperties!({ properties: 'nope', basePath: BASE_PATH });
    expect(warned).toEqual([]);
  });
});

describe('defineFormationModule — create', () => {
  test('passes the normalized bag through and returns the new id', async () => {
    let received: Record<string, unknown> | undefined;
    const module = buildModule({
      create: async ({ properties, projectId, actingUserId }) => {
        received = { ...properties, projectId, actingUserId };
        return { id: 'qta_1' };
      },
    });

    const id = await module.create({
      properties: { ...VALID_PROPERTIES, scopeRef: 'proj_1' },
      projectId: 42,
      actingUserId: 7,
    });

    expect(id).toBe('qta_1');
    expect(received).toEqual({
      ...VALID_PROPERTIES,
      scope_ref: 'proj_1',
      projectId: 42,
      actingUserId: 7,
    });
  });

  test('throws the first validation error instead of creating', async () => {
    const create = jest.fn();
    const module = buildModule({ create });

    await expect(
      module.create({
        properties: { scope: 'project' },
        projectId: 1,
        actingUserId: 7,
      })
    ).rejects.toThrow('`metric` is required');
    expect(create).not.toHaveBeenCalled();
  });
});

describe('defineFormationModule — update', () => {
  test('does not require fields that only a create must carry', async () => {
    let received: Record<string, unknown> | undefined;
    const module = buildModule({
      update: async ({ properties, physicalResourceId }) => {
        received = { ...properties, physicalResourceId };
      },
    });

    await module.update({
      projectId: 1,
      actingUserId: 7,
      properties: { limit: 5 },
      physicalResourceId: 'qta_1',
    });

    expect(received).toEqual({ limit: 5, physicalResourceId: 'qta_1' });
  });

  test('requiredOnUpdate keeps the required check on the update path', async () => {
    const module = buildModule({
      requiredOnUpdate: true,
      update: async () => {},
    });

    await expect(
      module.update({
        projectId: 1,
        actingUserId: 7,
        properties: { limit: 5 },
        physicalResourceId: 'qta_1',
      })
    ).rejects.toThrow('`scope` is required');
  });

  test('extraChecks sees forUpdate=true on the update path', async () => {
    const seen: boolean[] = [];
    const module = buildModule({
      extraChecks: ({ forUpdate }) => {
        seen.push(forUpdate);
      },
      update: async () => {},
    });

    await module.update({
      projectId: 1,
      actingUserId: 7,
      properties: {},
      physicalResourceId: 'qta_1',
    });
    expect(seen).toEqual([true]);
  });

  test('a module without an update still validates, then no-ops', async () => {
    const module = buildModule();

    await expect(
      module.update({
        projectId: 1,
        actingUserId: 7,
        properties: { nope: 1 },
        physicalResourceId: 'qta_1',
      })
    ).rejects.toThrow(/^Unknown quota field 'nope'\./);

    await expect(
      module.update({
        projectId: 1,
        actingUserId: 7,
        properties: { limit: 5 },
        physicalResourceId: 'qta_1',
      })
    ).resolves.toBeUndefined();
  });
});

describe('defineFormationModule — delete', () => {
  test('delegates to remove', async () => {
    const remove = jest.fn(async () => {});
    await buildModule({ remove }).delete({
      projectId: 1,
      actingUserId: 7,
      physicalResourceId: 'qta_1',
    });
    expect(remove).toHaveBeenCalledWith({ physicalResourceId: 'qta_1' });
  });
});

describe('defineFormationModule — read', () => {
  test('selects the schema-declared fields when no mapper is given', async () => {
    const module = buildModule({
      fetch: async () => {
        return { scope: 'project', metric: 'tokens', extra: 'ignored' };
      },
    });

    expect(
      await module.read!({
        projectId: 1,
        physicalResourceId: 'qta_1',
      })
    ).toEqual({
      scope: 'project',
      metric: 'tokens',
    });
  });

  test('uses the module mapper when the view is not a plain selection', async () => {
    const module = buildModule({
      fetch: async () => {
        return { scope: 'project', metric: 'tokens', extra: 'kept' };
      },
      read: (row) => {
        return { scope: row.scope, mode: row.extra };
      },
    });

    expect(
      await module.read!({
        projectId: 1,
        physicalResourceId: 'qta_1',
      })
    ).toEqual({
      scope: 'project',
      mode: 'kept',
    });
  });

  test('reports drift as null when the resource is gone', async () => {
    const module = buildModule({
      fetch: async () => {
        return null;
      },
    });
    expect(
      await module.read!({
        projectId: 1,
        physicalResourceId: 'qta_1',
      })
    ).toBeNull();
  });

  test('reports drift as null when the fetch throws', async () => {
    const module = buildModule({
      fetch: async () => {
        throw new Error('RESOURCE_NOT_FOUND');
      },
    });
    expect(
      await module.read!({
        projectId: 1,
        physicalResourceId: 'qta_1',
      })
    ).toBeNull();
  });

  test('a write-only module reads null and declares writeOnly', async () => {
    const module = buildModule({ writeOnly: true });
    expect(module.writeOnly).toBe(true);
    expect(
      await module.read!({
        projectId: 1,
        physicalResourceId: 'qta_1',
      })
    ).toBeNull();
  });

  test('writeOnly and getAttributes are absent unless declared', () => {
    const module = buildModule();
    expect(module.writeOnly).toBeUndefined();
    expect(module.getAttributes).toBeUndefined();
    expect(module.sanitizeLastAppliedProperties).toBeUndefined();
  });

  test('getAttributes and sanitizeLastAppliedProperties pass through', async () => {
    const module = buildModule({
      getAttributes: async () => {
        return { secret: 'shh' };
      },
      sanitizeLastAppliedProperties: ({ value: _value, ...rest }) => {
        return rest;
      },
    });

    expect(
      await module.getAttributes!({
        projectId: 1,
        physicalResourceId: 'qta_1',
      })
    ).toEqual({ secret: 'shh' });
    expect(
      module.sanitizeLastAppliedProperties!({ name: 'n', value: 'v' })
    ).toEqual({ name: 'n' });
  });
});

describe('defineFormationModule — authorization', () => {
  test('an update operation with no declared action is refused', () => {
    expect(() => {
      return defineFormationModule<QuotaRow>({
        resourceType: 'quota',
        authorization: {
          srnResourceType: 'quota',
          create: 'quotas:CreateQuota',
          delete: 'quotas:DeleteQuota',
        },
        create: async () => {
          return { id: 'qta_created' };
        },
        update: async () => {},
        remove: async () => {},
      });
    }).toThrow(/declares an update operation but no authorization.update/);
  });

  test('a declared update action with no update operation is refused', () => {
    expect(() => {
      return defineFormationModule<QuotaRow>({
        resourceType: 'quota',
        authorization: {
          srnResourceType: 'quota',
          create: 'quotas:CreateQuota',
          update: 'quotas:UpdateQuota',
          delete: 'quotas:DeleteQuota',
        },
        create: async () => {
          return { id: 'qta_created' };
        },
        remove: async () => {},
      });
    }).toThrow(
      /declares an authorization.update action but no update operation/
    );
  });
});
