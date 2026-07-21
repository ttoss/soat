import createDebug from 'debug';

import type { FormationModule, ValidationError } from '../formationsTypes';
import { createQuota, deleteQuota, getQuota, updateQuota } from '../quotas';
import {
  normalizePropertyKeys,
  toNullableNumber,
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

const log = createDebug('soat:formations:quotas');

const SCHEMA_NAME = 'QuotaResourceProperties';
const RESOURCE_LABEL = 'quota';

// ── Property validation ──────────────────────────────────────────────────

const validateQuotaProperties = (args: {
  properties: unknown;
  basePath: string;
  forUpdate?: boolean;
}): ValidationError[] => {
  const { basePath, forUpdate } = args;
  if (!isObjectRecord(args.properties)) {
    return [
      { path: basePath, message: 'Quota `properties` must be an object' },
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

export const quotasFormationModule: FormationModule = {
  resourceType: 'quota',

  validateProperties: ({ properties, basePath }) => {
    return validateQuotaProperties({ properties, basePath });
  },

  create: async ({ properties: rawProperties, projectId }) => {
    const errors = validateQuotaProperties({
      properties: rawProperties,
      basePath: 'resources.<quota>.properties',
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const properties = isObjectRecord(rawProperties)
      ? normalizePropertyKeys(rawProperties)
      : rawProperties;

    const result = await createQuota({
      projectId,
      scope: properties.scope as string,
      scopeRef: toNullableString(properties.scope_ref) ?? undefined,
      metric: properties.metric as string,
      window: properties.window as string,
      limit: properties.limit,
      mode: toOptionalString(properties.mode) ?? undefined,
    });

    log(
      'created quota from formation: projectId=%d quotaId=%s',
      projectId,
      result.id
    );
    return result.id;
  },

  // Only `limit` and `mode` are mutable; scope/metric/window are immutable and
  // rejected as unknown-on-update would not apply (they are simply ignored here,
  // matching the REST update contract).
  update: async ({ properties: rawProperties, physicalResourceId }) => {
    const errors = validateQuotaProperties({
      properties: rawProperties,
      basePath: 'resources.<quota>.properties',
      forUpdate: true,
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const properties = isObjectRecord(rawProperties)
      ? normalizePropertyKeys(rawProperties)
      : rawProperties;

    await updateQuota({
      id: physicalResourceId,
      limit: toNullableNumber(properties.limit) ?? undefined,
      mode: toOptionalString(properties.mode) ?? undefined,
    });

    log('updated quota from formation: id=%s', physicalResourceId);
  },

  delete: async ({ physicalResourceId }) => {
    await deleteQuota({ id: physicalResourceId });
    log('deleted quota from formation: id=%s', physicalResourceId);
  },

  read: async ({ physicalResourceId }) => {
    try {
      const quota = await getQuota({ id: physicalResourceId });
      return {
        scope: quota.scope,
        scope_ref: quota.scopeRef,
        metric: quota.metric,
        window: quota.window,
        limit: quota.limit,
        mode: quota.mode,
      };
    } catch {
      return null;
    }
  },
};
