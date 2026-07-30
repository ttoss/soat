import createDebug from 'debug';

import type { FormationModule, ValidationError } from '../formationsTypes';
import {
  createModelRoute,
  deleteModelRoute,
  getModelRoute,
  updateModelRoute,
  validateModelRouteBreakerConfig,
  validateModelRouteRetryOn,
  validateModelRouteTargets,
} from '../modelRoutes';
import {
  normalizePropertyKeys,
  toNullableArray,
  toNullableNumber,
  toOptionalString,
} from '../resource-inputs/normalizers';
import {
  isObjectRecord,
  loadModuleSpec,
  pushFieldTypeErrors,
  pushRequiredFieldErrors,
  pushUnknownFieldErrors,
} from './formationSpecLoader';

const log = createDebug('soat:formations:model-routes');

const SCHEMA_NAME = 'ModelRouteResourceProperties';
const RESOURCE_LABEL = 'model route';

// ── Property validation ──────────────────────────────────────────────────

/**
 * The routing rules a template must satisfy, enforced with the same exported
 * validators the REST handlers use (`.claude/rules/modules.md`, Shared Business
 * Rules): a non-empty ordered target list within the attempt cap, a known
 * `retry_on` vocabulary, and positive breaker values.
 *
 * The schema loader only knows each property's declared type, so it cannot see
 * inside `targets` — these checks are what keep a template from declaring a
 * route the REST API would reject.
 */
/**
 * Breaker values default at the lib layer, so a template that declares neither
 * is valid; the placeholder `1` stands in for a value the lib will default, so
 * only what the template actually declared can fail validation.
 */
const pushBreakerErrors = (args: {
  properties: Record<string, unknown>;
  basePath: string;
  errors: ValidationError[];
}): void => {
  const { properties, basePath, errors } = args;
  if (
    properties.failure_threshold === undefined &&
    properties.cooldown_seconds === undefined
  ) {
    return;
  }

  const message = validateModelRouteBreakerConfig({
    failureThreshold: properties.failure_threshold ?? 1,
    cooldownSeconds: properties.cooldown_seconds ?? 1,
  });
  if (message) errors.push({ path: basePath, message });
};

const pushRoutingRuleErrors = (args: {
  properties: Record<string, unknown>;
  basePath: string;
  errors: ValidationError[];
  forUpdate?: boolean;
}): void => {
  const { properties, basePath, errors, forUpdate } = args;

  if (properties.targets !== undefined || !forUpdate) {
    const message = validateModelRouteTargets(properties.targets);
    if (message) errors.push({ path: `${basePath}.targets`, message });
  }

  if (properties.retry_on !== undefined) {
    const message = validateModelRouteRetryOn(properties.retry_on);
    if (message) errors.push({ path: `${basePath}.retry_on`, message });
  }

  pushBreakerErrors({ properties, basePath, errors });
};

const validateModelRouteProperties = (args: {
  properties: unknown;
  basePath: string;
  forUpdate?: boolean;
}): ValidationError[] => {
  const { basePath, forUpdate } = args;
  if (!isObjectRecord(args.properties)) {
    return [
      { path: basePath, message: 'Model route `properties` must be an object' },
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

  pushRoutingRuleErrors({ properties, basePath, errors, forUpdate });

  return errors;
};

const assertValid = (args: {
  properties: unknown;
  basePath: string;
  forUpdate?: boolean;
}): Record<string, unknown> => {
  const errors = validateModelRouteProperties(args);
  if (errors.length > 0) {
    throw new Error(errors[0].message);
  }
  return normalizePropertyKeys(args.properties as Record<string, unknown>);
};

// ── Module export ────────────────────────────────────────────────────────

export const modelRoutesFormationModule: FormationModule = {
  resourceType: 'model_route',

  validateProperties: ({ properties, basePath }) => {
    return validateModelRouteProperties({ properties, basePath });
  },

  create: async ({ properties: rawProperties, projectId }) => {
    const properties = assertValid({
      properties: rawProperties,
      basePath: 'resources.<model_route>.properties',
    });

    const result = await createModelRoute({
      projectId,
      name: toOptionalString(properties.name),
      // Targets are declared and stored in the wire shape, so the array is
      // passed through as a value — nothing walks the keys the author wrote.
      targets: properties.targets,
      retryOn: toNullableArray<string>(properties.retry_on) ?? undefined,
      failureThreshold:
        toNullableNumber(properties.failure_threshold) ?? undefined,
      cooldownSeconds:
        toNullableNumber(properties.cooldown_seconds) ?? undefined,
    });

    log(
      'created model route from formation: projectId=%d routeId=%s',
      projectId,
      result.id
    );
    return result.id;
  },

  update: async ({ properties: rawProperties, physicalResourceId }) => {
    const properties = assertValid({
      properties: rawProperties,
      basePath: 'resources.<model_route>.properties',
      forUpdate: true,
    });

    await updateModelRoute({
      id: physicalResourceId,
      name: toOptionalString(properties.name),
      targets: properties.targets,
      retryOn: toNullableArray<string>(properties.retry_on) ?? undefined,
      failureThreshold:
        toNullableNumber(properties.failure_threshold) ?? undefined,
      cooldownSeconds:
        toNullableNumber(properties.cooldown_seconds) ?? undefined,
    });

    log('updated model route from formation: id=%s', physicalResourceId);
  },

  delete: async ({ physicalResourceId }) => {
    await deleteModelRoute({ id: physicalResourceId });
    log('deleted model route from formation: id=%s', physicalResourceId);
  },

  read: async ({ physicalResourceId }) => {
    try {
      const route = await getModelRoute({ id: physicalResourceId });
      return {
        name: route.name,
        targets: route.targets,
        retry_on: route.retry_on,
        failure_threshold: route.failure_threshold,
        cooldown_seconds: route.cooldown_seconds,
      };
    } catch {
      return null;
    }
  },
};
