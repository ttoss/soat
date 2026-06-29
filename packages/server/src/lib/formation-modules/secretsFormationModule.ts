import createDebug from 'debug';

import type { FormationModule, ValidationError } from '../formationsTypes';
import { toOptionalString } from '../resource-inputs/normalizers';
import { createSecret, deleteSecret, updateSecret } from '../secrets';
import {
  isObjectRecord,
  loadModuleSpec,
  pushFieldTypeErrors,
  pushRequiredFieldErrors,
  pushUnknownFieldErrors,
} from './formationSpecLoader';

const log = createDebug('soat:formations:secrets');

const SCHEMA_NAME = 'SecretResourceProperties';
const RESOURCE_LABEL = 'secret';

// ── Key normalization ────────────────────────────────────────────────────

const camelToSnakeKey = (key: string): string => {
  return key.replace(/[A-Z]/g, (char) => {
    return `_${char.toLowerCase()}`;
  });
};

const normalizePropertyKeys = (
  properties: Record<string, unknown>
): Record<string, unknown> => {
  return Object.fromEntries(
    Object.entries(properties).map(([key, value]) => {
      return [camelToSnakeKey(key), value];
    })
  );
};

// ── Property validation ──────────────────────────────────────────────────

const validateSecretProperties = (args: {
  properties: unknown;
  basePath: string;
  forUpdate?: boolean;
}): ValidationError[] => {
  const { basePath, forUpdate } = args;
  if (!isObjectRecord(args.properties)) {
    return [
      {
        path: basePath,
        message: 'Secret `properties` must be an object',
      },
    ];
  }

  const properties = normalizePropertyKeys(args.properties);
  const spec = loadModuleSpec({ schemaName: SCHEMA_NAME });
  const errors: ValidationError[] = [];
  pushUnknownFieldErrors({
    spec,
    resourceLabel: RESOURCE_LABEL,
    properties,
    basePath,
    errors,
  });
  if (!forUpdate) {
    pushRequiredFieldErrors({ spec, properties, basePath, errors });
  }
  pushFieldTypeErrors({ spec, properties, basePath, errors });

  return errors;
};

// ── Module export ────────────────────────────────────────────────────────

export const secretsFormationModule: FormationModule = {
  resourceType: 'secret',

  validateProperties: ({ properties, basePath }) => {
    return validateSecretProperties({ properties, basePath });
  },

  create: async ({ properties: rawProperties, projectId }) => {
    const errors = validateSecretProperties({
      properties: rawProperties,
      basePath: 'resources.<secret>.properties',
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const properties = isObjectRecord(rawProperties)
      ? normalizePropertyKeys(rawProperties)
      : rawProperties;

    const result = await createSecret({
      projectId,
      name: properties.name as string,
      // `value` is required by SecretResourceProperties and validated above.
      value: properties.value as string,
    });

    log(
      'created secret from formation: projectId=%d secretId=%s',
      projectId,
      result.id
    );
    return result.id;
  },

  update: async ({ properties: rawProperties, physicalResourceId }) => {
    const errors = validateSecretProperties({
      properties: rawProperties,
      basePath: 'resources.<secret>.properties',
      forUpdate: true,
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const properties = isObjectRecord(rawProperties)
      ? normalizePropertyKeys(rawProperties)
      : rawProperties;

    await updateSecret({
      id: physicalResourceId,
      name: toOptionalString(properties.name) ?? undefined,
      value: toOptionalString(properties.value) ?? undefined,
    });

    log('updated secret from formation: id=%s', physicalResourceId);
  },

  delete: async ({ physicalResourceId }) => {
    await deleteSecret({ id: physicalResourceId, force: true });
    log('deleted secret from formation: id=%s', physicalResourceId);
  },

  // Secrets are write-only: the value cannot be read back. Always return null
  // so the planner treats any existing secret as needing an update.
  read: async () => {
    return null;
  },

  // Strip the plaintext value before it is stored in lastAppliedProperties so
  // it is never persisted unencrypted in the formation_resources table.
  sanitizeLastAppliedProperties: (properties) => {
    const { value: _value, ...rest } = properties;
    return rest;
  },
};
