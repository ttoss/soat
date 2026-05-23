import createDebug from 'debug';

import { createApiKey, deleteApiKey, updateApiKey } from '../apiKeys';
import {
  lookupPolicyInternalIds,
  lookupProjectOwnerUserId,
} from '../formationsHelpers';
import type { FormationModule, ValidationError } from '../formationsTypes';
import { toOptionalString } from '../resource-inputs/normalizers';
import {
  isObjectRecord,
  loadModuleSpec,
  pushFieldTypeErrors,
  pushRequiredFieldErrors,
  pushUnknownFieldErrors,
} from './formationSpecLoader';

const log = createDebug('soat:formations:apiKeys');

const SCHEMA_NAME = 'ApiKeyResourceProperties';
const RESOURCE_LABEL = 'api_key';

// ── Key normalization ────────────────────────────────────────────────────
// caseTransform middleware converts all nested request body keys to camelCase.
// Formation templates are stored with those camelCase keys. Normalize back to
// snake_case so the spec validators and property accessors work correctly.

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

const validateApiKeyProperties = (args: {
  properties: unknown;
  basePath: string;
  forUpdate?: boolean;
}): ValidationError[] => {
  const { basePath, forUpdate } = args;
  if (!isObjectRecord(args.properties)) {
    return [
      {
        path: basePath,
        message: 'API key `properties` must be an object',
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

export const apiKeysFormationModule: FormationModule = {
  resourceType: 'api_key',

  validateProperties: ({ properties, basePath }) => {
    return validateApiKeyProperties({ properties, basePath });
  },

  create: async ({ properties: rawProperties, projectId }) => {
    const errors = validateApiKeyProperties({
      properties: rawProperties,
      basePath: 'resources.<api_key>.properties',
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const properties = isObjectRecord(rawProperties)
      ? normalizePropertyKeys(rawProperties)
      : rawProperties;

    const userId = await lookupProjectOwnerUserId(projectId);

    const rawPolicyIds = properties.policy_ids;
    const policyPublicIds = Array.isArray(rawPolicyIds)
      ? (rawPolicyIds as string[])
      : [];
    const policyIds =
      policyPublicIds.length > 0
        ? await lookupPolicyInternalIds(policyPublicIds)
        : undefined;

    const result = await createApiKey({
      userId,
      projectId,
      name: properties.name as string,
      policyIds,
    });

    log(
      'created API key from formation: projectId=%d keyId=%s',
      projectId,
      result.id
    );
    return result.id;
  },

  update: async ({ properties: rawProperties, physicalResourceId }) => {
    const errors = validateApiKeyProperties({
      properties: rawProperties,
      basePath: 'resources.<api_key>.properties',
      forUpdate: true,
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const properties = isObjectRecord(rawProperties)
      ? normalizePropertyKeys(rawProperties)
      : rawProperties;

    let policyIds: number[] | undefined;
    const rawPolicyIds = properties.policy_ids;
    if (rawPolicyIds !== undefined) {
      const publicIds = Array.isArray(rawPolicyIds)
        ? (rawPolicyIds as string[])
        : [];
      policyIds = await lookupPolicyInternalIds(publicIds);
    }

    await updateApiKey({
      id: physicalResourceId,
      name: toOptionalString(properties.name),
      policyIds,
    });

    log('updated API key from formation: keyId=%s', physicalResourceId);
  },

  delete: async ({ physicalResourceId }) => {
    await deleteApiKey({ id: physicalResourceId });
    log('deleted API key from formation: keyId=%s', physicalResourceId);
  },
};
