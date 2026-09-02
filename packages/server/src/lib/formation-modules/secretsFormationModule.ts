import { toOptionalString } from '../resource-inputs/normalizers';
import { createSecret, deleteSecret, updateSecret } from '../secrets';
import { defineFormationModule } from './defineFormationModule';

// The value cannot be read back, so `writeOnly` tells the planner to diff
// against the last-applied snapshot instead of reading the null as "deleted
// externally".
export const secretsFormationModule = defineFormationModule({
  resourceType: 'secret',
  authorization: {
    srnResourceType: 'secret',
    create: 'secrets:CreateSecret',
    update: 'secrets:UpdateSecret',
    delete: 'secrets:DeleteSecret',
  },

  create: ({ properties, projectId }) => {
    return createSecret({
      projectId,
      name: properties.name as string,
      // `value` is required by SecretResourceProperties and validated above.
      value: properties.value as string,
    });
  },

  update: async ({ properties, physicalResourceId }) => {
    await updateSecret({
      id: physicalResourceId,
      name: toOptionalString(properties.name) ?? undefined,
      value: toOptionalString(properties.value) ?? undefined,
    });
  },

  remove: ({ physicalResourceId }) => {
    return deleteSecret({ id: physicalResourceId, force: true });
  },

  writeOnly: true,

  // Strip the plaintext value before it is stored in lastAppliedProperties so
  // it is never persisted unencrypted in the formation_resources table.
  sanitizeLastAppliedProperties: (properties) => {
    const { value: _value, ...rest } = properties;
    return rest;
  },
});
