import createDebug from 'debug';

import {
  lookupPolicyInternalIds,
  lookupProjectOwnerUserId,
} from '../formationsHelpers';
import type { FormationModule, ValidationError } from '../formationsTypes';
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
  validateTriggerShape,
} from '../triggers';
import {
  isFormationExpression,
  isObjectRecord,
  loadModuleSpec,
  pushFieldTypeErrors,
  pushRequiredFieldErrors,
  pushUnknownFieldErrors,
} from './formationSpecLoader';

const log = createDebug('soat:formations:triggers');

const SCHEMA_NAME = 'TriggerResourceProperties';
const RESOURCE_LABEL = 'trigger';

/** Narrows an untyped template value to a plain input object, else undefined. */
const toInputObject = (value: unknown): Record<string, unknown> | undefined => {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
};

const toOptionalBoolean = (value: unknown): boolean | undefined => {
  return value != null ? Boolean(value) : undefined;
};

// ── Property validation ──────────────────────────────────────────────────

/**
 * Reuses the transport-independent business rules from the lib so formation
 * templates enforce the same invariants as the REST API (cron iff schedule,
 * action iff tool, and a parseable 5-field UTC cron). Only meaningful once the
 * type-dependent fields are present, well-typed, and schema-valid — so it is a
 * no-op when `errors` already has entries.
 *
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
    });
    // Only a literal cron can be parsed here; an expression's real value is
    // validated at apply time once the parameter/ref is resolved.
    if (properties.type === 'schedule' && typeof properties.cron === 'string') {
      validateCronExpression(properties.cron);
    }
  } catch (error) {
    errors.push({
      path: basePath,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

const validateTriggerProperties = (args: {
  properties: unknown;
  basePath: string;
  forUpdate?: boolean;
}): ValidationError[] => {
  const { basePath, forUpdate } = args;
  if (!isObjectRecord(args.properties)) {
    return [
      { path: basePath, message: 'Trigger `properties` must be an object' },
    ];
  }

  const properties = args.properties;
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
  pushShapeRuleErrors({ properties, basePath, errors });

  return errors;
};

// ── Module export ────────────────────────────────────────────────────────

export const triggersFormationModule: FormationModule = {
  resourceType: 'trigger',

  validateProperties: ({ properties, basePath }) => {
    return validateTriggerProperties({ properties, basePath });
  },

  create: async ({ properties, projectId }) => {
    const errors = validateTriggerProperties({
      properties,
      basePath: 'resources.<trigger>.properties',
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    // Firings run as the project owner (there is no request user in a
    // formation deploy); this is the run-as identity re-checked at fire time.
    const createdByUserId = await lookupProjectOwnerUserId(projectId);
    const policyPublicId = toOptionalString(properties.policy_id);
    const policyId = policyPublicId
      ? (await lookupPolicyInternalIds([policyPublicId]))[0]
      : null;

    const result = await createTrigger({
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
      active: toOptionalBoolean(properties.active),
    });

    log(
      'created trigger from formation: projectId=%d triggerId=%s',
      projectId,
      result.id
    );
    return result.id;
  },

  update: async ({ properties, physicalResourceId }) => {
    const errors = validateTriggerProperties({
      properties,
      basePath: 'resources.<trigger>.properties',
      forUpdate: true,
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

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
      active: toOptionalBoolean(properties.active),
    });

    log('updated trigger from formation: id=%s', physicalResourceId);
  },

  delete: async ({ physicalResourceId }) => {
    await deleteTrigger({ id: physicalResourceId });
    log('deleted trigger from formation: id=%s', physicalResourceId);
  },

  read: async ({ physicalResourceId }) => {
    const trigger = await findTrigger({ id: physicalResourceId });
    if (!trigger) return null;
    return {
      name: trigger.name,
      description: trigger.description,
      type: trigger.type,
      target_type: trigger.targetType,
      target_id: trigger.targetId,
      action: trigger.action,
      input: trigger.input,
      cron: trigger.cron,
      active: trigger.active,
      policy_id: trigger.policyId,
    };
  },

  getAttributes: async ({ physicalResourceId }) => {
    const result = await findTriggerSecret({ id: physicalResourceId });
    const attrs: Record<string, string> = {};
    if (result) attrs.secret = result.secret;
    return attrs;
  },
};
