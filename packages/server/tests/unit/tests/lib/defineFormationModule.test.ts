import { defineFormationModule } from 'src/lib/formation-modules/defineFormationModule';

// A `lib/` test per the keep-list rule: the update operation and the update
// action are checked against each other when a module is defined, which is at
// import time — a boot failure no request can reach.

type QuotaRow = { scope: string; metric: string; extra: string };

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

describe('defineFormationModule — extra checks', () => {
  const formationModule = defineFormationModule<QuotaRow>({
    resourceType: 'policy',
    authorization: {
      srnResourceType: 'policy',
      create: 'policies:CreatePolicy',
      delete: 'policies:DeletePolicy',
    },
    extraChecks: ({ basePath, errors }) => {
      errors.push({ path: basePath, message: 'whole' });
      errors.push({ path: `${basePath}.document`, message: 'document' });
      errors.push({ path: `${basePath}.name`, message: 'name' });
    },
    create: async () => {
      return { id: 'pol_created' };
    },
    remove: async () => {},
  });

  const messagesFor = (document: unknown) => {
    const errors =
      formationModule.validateProperties?.({
        properties: { name: 'p', document },
        basePath: 'resources.P.properties',
        projectPublicId: null,
      }) ?? [];
    return errors.map((error) => {
      return error.message;
    });
  };

  test.each([
    ['itself', { sub: 'x' }],
    [
      'nested',
      {
        statement: [
          { effect: 'Allow', action: ['*'], resource: [{ ref: 'Other' }] },
        ],
      },
    ],
    [
      'deep',
      {
        statement: [
          { effect: 'Allow', action: ['*'], resource: [{ param: 'P' }] },
        ],
      },
    ],
  ])('leave a field holding an expression %s to the apply', (_where, doc) => {
    expect(messagesFor(doc)).toEqual(['whole', 'name']);
  });

  test('check a field holding only literals', () => {
    expect(
      messagesFor({
        statement: [{ effect: 'Allow', action: ['*'], resource: ['foo'] }],
      })
    ).toEqual(['whole', 'document', 'name']);
  });
});
