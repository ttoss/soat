import type { AiProviderSlug } from '@soat/postgresdb';
import createDebug from 'debug';

import {
  createAiProvider,
  deleteAiProvider,
  updateAiProvider,
} from '../aiProviders';
import { lookupSecretInternalId } from '../formationsHelpers';
import type { FormationModule, ValidationError } from '../formationsTypes';
import {
  toNullableObject,
  toNullableString,
  toOptionalString,
} from '../resource-inputs/normalizers';
import {
  isObjectRecord,
  loadModuleSpec,
  pushFieldTypeErrors,
  pushRequiredFieldErrors,
  pushUnknownFieldErrors,
} from './formationSpecLoader';

const log = createDebug('soat:formations:aiProviders');

const SCHEMA_NAME = 'AiProviderResourceProperties';
const RESOURCE_LABEL = 'ai_provider';

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

const validateAiProviderProperties = (args: {
  properties: unknown;
  basePath: string;
  forUpdate?: boolean;
}): ValidationError[] => {
  const { basePath, forUpdate } = args;
  if (!isObjectRecord(args.properties)) {
    return [
      {
        path: basePath,
        message: 'AI provider `properties` must be an object',
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

export const aiProvidersFormationModule: FormationModule = {
  resourceType: 'ai_provider',

  validateProperties: ({ properties, basePath }) => {
    return validateAiProviderProperties({ properties, basePath });
  },

  create: async ({ properties: rawProperties, projectId }) => {
    const errors = validateAiProviderProperties({
      properties: rawProperties,
      basePath: 'resources.<ai_provider>.properties',
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const properties = isObjectRecord(rawProperties)
      ? normalizePropertyKeys(rawProperties)
      : rawProperties;

    const secretPublicId = toNullableString(properties.secret_id);
    const secretId = secretPublicId
      ? await lookupSecretInternalId(secretPublicId)
      : undefined;

    const result = await createAiProvider({
      projectId,
      secretId,
      name: properties.name as string,
      provider: properties.provider as AiProviderSlug,
      defaultModel: properties.default_model as string,
      baseUrl: toOptionalString(properties.base_url),
      config:
        (toNullableObject(properties.config) as Record<string, unknown>) ??
        undefined,
    });

    log(
      'created AI provider from formation: projectId=%d providerId=%s',
      projectId,
      result.id
    );
    return result.id;
  },

  update: async ({ properties: rawProperties, physicalResourceId }) => {
    const errors = validateAiProviderProperties({
      properties: rawProperties,
      basePath: 'resources.<ai_provider>.properties',
      forUpdate: true,
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const properties = isObjectRecord(rawProperties)
      ? normalizePropertyKeys(rawProperties)
      : rawProperties;

    let secretId: number | undefined;
    const rawSecretId = properties.secret_id;
    if (rawSecretId !== undefined) {
      const secretPublicId = toNullableString(rawSecretId);
      if (secretPublicId) {
        secretId = await lookupSecretInternalId(secretPublicId);
      }
    }

    await updateAiProvider({
      id: physicalResourceId,
      secretId,
      name: toOptionalString(properties.name),
      provider: toOptionalString(properties.provider) as
        | AiProviderSlug
        | undefined,
      defaultModel: toOptionalString(properties.default_model),
      baseUrl: toNullableString(properties.base_url),
      config: toNullableObject(properties.config) as
        | Record<string, unknown>
        | null
        | undefined,
    });

    log(
      'updated AI provider from formation: providerId=%s',
      physicalResourceId
    );
  },

  delete: async ({ physicalResourceId }) => {
    await deleteAiProvider({ id: physicalResourceId });
    log(
      'deleted AI provider from formation: providerId=%s',
      physicalResourceId
    );
  },
};
