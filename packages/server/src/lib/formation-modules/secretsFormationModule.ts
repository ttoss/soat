import { toOptionalString } from '../resource-inputs/normalizers';
import { createSecret, deleteSecret, updateSecret } from '../secrets';
import { defineFormationModule } from './defineFormationModule';

// Secrets are write-only: the value cannot be read back, so the module declares
// no `fetch` and `writeOnly: true` tells the planner to diff against the
// persisted lastAppliedProperties snapshot instead of reading the null back as
// "resource deleted externally".
export const secretsFormationModule = defineFormationModule({
  resourceType: 'secret',

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
