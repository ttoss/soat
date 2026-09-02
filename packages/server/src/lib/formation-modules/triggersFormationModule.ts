import {
  lookupPolicyInternalIds,
  lookupProjectOwnerUserId,
} from '../formationsHelpers';
import type { ValidationError } from '../formationsTypes';
import {
  toNullableString,
  toOptionalString,
} from '../resource-inputs/normalizers';
import {
  createTrigger,
  deleteTrigger,
  findTrigger,
  findTriggerSecret,
  updateTrigger,
  validateCronExpression,
  validateEventPattern,
  validateTriggerShape,
} from '../triggers';
import { defineFormationModule } from './defineFormationModule';
import { isFormationExpression } from './formationSpecLoader';

/** Narrows an untyped template value to a plain input object, else undefined. */
const toInputObject = (value: unknown): Record<string, unknown> | undefined => {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
};

const toOptionalBoolean = (value: unknown): boolean | undefined => {
  return value != null ? Boolean(value) : undefined;
};

/**
 * A field supplied as an unresolved formation expression (`{ sub }`, `{ param }`,
 * `{ ref }`) is treated as *present* for the presence/exclusivity checks — its
 * literal value only exists after parameter/ref resolution at apply time, where
 * the real cron string is re-validated. Without this, a parameterized `cron`
 * (e.g. `cron: { sub: "${healthcheck_cron}" }`) normalizes to `null` here and
 * trips "cron is required for schedule triggers" even though it is provided.
 */
const EXPRESSION_PLACEHOLDER = '<expression>';

const shapeFieldValue = (value: unknown): string | null => {
  if (isFormationExpression(value)) return EXPRESSION_PLACEHOLDER;
  return toNullableString(value) ?? null;
};

/**
 * Reuses the transport-independent business rules from the lib so formation
 * templates enforce the same invariants as the REST API (cron iff schedule,
 * event_pattern iff event, action iff tool, and a parseable 5-field UTC cron). Only meaningful once the
 * type-dependent fields are present, well-typed, and schema-valid — so it is a
 * no-op when `errors` already has entries.
 */
const pushShapeRuleErrors = (args: {
  properties: Record<string, unknown>;
  basePath: string;
  errors: ValidationError[];
}): void => {
  const { properties, basePath, errors } = args;
  if (
    errors.length > 0 ||
    typeof properties.type !== 'string' ||
    typeof properties.target_type !== 'string'
  ) {
    return;
  }
  try {
    validateTriggerShape({
      type: properties.type,
      targetType: properties.target_type,
      action: shapeFieldValue(properties.action),
      cron: shapeFieldValue(properties.cron),
      eventPattern: shapeFieldValue(properties.event_pattern),
    });
    // Only a literal cron can be parsed here; an expression's real value is
    // validated at apply time once the parameter/ref is resolved.
    if (properties.type === 'schedule' && typeof properties.cron === 'string') {
      validateCronExpression(properties.cron);
    }
    if (
      properties.type === 'event' &&
      typeof properties.event_pattern === 'string'
    ) {
      validateEventPattern(properties.event_pattern);
    }
  } catch (error) {
    errors.push({
      path: basePath,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

export const triggersFormationModule = defineFormationModule({
  resourceType: 'trigger',
  authorization: {
    srnResourceType: 'trigger',
    create: 'triggers:CreateTrigger',
    update: 'triggers:UpdateTrigger',
    delete: 'triggers:DeleteTrigger',
  },

  extraChecks: pushShapeRuleErrors,

  create: async ({ properties, projectId }) => {
    // Firings run as the project owner (there is no request user in a
    // formation deploy); this is the run-as identity re-checked at fire time.
    const createdByUserId = await lookupProjectOwnerUserId(projectId);
    const policyPublicId = toOptionalString(properties.policy_id);
    const policyId = policyPublicId
      ? (await lookupPolicyInternalIds([policyPublicId]))[0]
      : null;

    return createTrigger({
      projectId,
      createdByUserId,
      policyId,
      name: properties.name as string,
      description: toOptionalString(properties.description) ?? undefined,
      type: properties.type as string,
      targetType: properties.target_type as string,
      targetId: properties.target_id as string,
      action: toOptionalString(properties.action) ?? undefined,
      input: toInputObject(properties.input),
      cron: toOptionalString(properties.cron) ?? undefined,
      eventPattern: toOptionalString(properties.event_pattern) ?? undefined,
      active: toOptionalBoolean(properties.active),
    });
  },

  update: async ({ properties, physicalResourceId }) => {
    const policyPublicId = toOptionalString(properties.policy_id);
    const policyId = policyPublicId
      ? (await lookupPolicyInternalIds([policyPublicId]))[0]
      : undefined;

    await updateTrigger({
      id: physicalResourceId,
      policyId,
      name: toOptionalString(properties.name),
      description: toNullableString(properties.description),
      targetType: toOptionalString(properties.target_type),
      targetId: toOptionalString(properties.target_id),
      action: toNullableString(properties.action),
      input: toInputObject(properties.input),
      cron: toNullableString(properties.cron),
      eventPattern: toNullableString(properties.event_pattern),
      active: toOptionalBoolean(properties.active),
    });
  },

  remove: ({ physicalResourceId }) => {
    return deleteTrigger({ id: physicalResourceId });
  },

  fetch: ({ physicalResourceId }) => {
    return findTrigger({ id: physicalResourceId });
  },

  getAttributes: async ({ physicalResourceId }) => {
    const result = await findTriggerSecret({ id: physicalResourceId });
    const attrs: Record<string, string> = {};
    if (result) attrs.secret = result.secret;
    return attrs;
  },
});
