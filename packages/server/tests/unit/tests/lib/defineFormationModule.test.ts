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
