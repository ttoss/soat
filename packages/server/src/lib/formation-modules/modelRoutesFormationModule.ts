import type { ValidationError } from '../formationsTypes';
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
  toNullableArray,
  toNullableNumber,
  toOptionalString,
} from '../resource-inputs/normalizers';
import { defineFormationModule } from './defineFormationModule';

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

export const modelRoutesFormationModule = defineFormationModule({
  resourceType: 'model_route',
  authorization: {
    srnResourceType: 'model_route',
    create: 'model-routes:CreateModelRoute',
    update: 'model-routes:UpdateModelRoute',
    delete: 'model-routes:DeleteModelRoute',
  },
  resourceLabel: 'model route',

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
  extraChecks: ({ properties, basePath, forUpdate, errors }) => {
    if (properties.targets !== undefined || !forUpdate) {
      const message = validateModelRouteTargets(properties.targets);
      if (message) errors.push({ path: `${basePath}.targets`, message });
    }

    if (properties.retry_on !== undefined) {
      const message = validateModelRouteRetryOn(properties.retry_on);
      if (message) errors.push({ path: `${basePath}.retry_on`, message });
    }

    pushBreakerErrors({ properties, basePath, errors });
  },

  create: ({ properties, projectId }) => {
    return createModelRoute({
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
  },

  update: async ({ properties, physicalResourceId }) => {
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
  },

  remove: ({ physicalResourceId }) => {
    return deleteModelRoute({ id: physicalResourceId });
  },

  fetch: ({ physicalResourceId }) => {
    return getModelRoute({ id: physicalResourceId });
  },
});
