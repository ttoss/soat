import type { ValidationError } from '../formationsTypes';
import {
  toNullableArray,
  toNullableObject,
  toNullableString,
  toOptionalString,
} from '../resource-inputs/normalizers';
import { SECRET_USE_ACTION, secretRefIds } from '../secretUse';
import { toStoredToolContext } from '../toolContext';
import {
  createTrigger,
  deleteTrigger,
  findTrigger,
  readTriggerEvents,
  updateTrigger,
  validateCronExpression,
  validateTriggerShape,
} from '../triggers';
import { defineFormationModule } from './defineFormationModule';
import {
  isFormationExpression,
  isObjectRecord,
  pushStringBagValueErrors,
} from './formationSpecLoader';

/** Narrows an untyped template value to a plain input object, else undefined. */
const toInputObject = (value: unknown): Record<string, unknown> | undefined => {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
};

/** An `event_data` filter as the template wrote it; `null` clears it. */
const toEventData = (
  value: unknown
): Record<string, unknown> | null | undefined => {
  const object = toNullableObject(value);
  return object == null ? object : toInputObject(object);
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

/** A list field whose items may be expressions, with each one resolved later. */
const shapeListValue = (value: unknown): unknown => {
  if (isFormationExpression(value)) return ['*'];
  if (!Array.isArray(value)) return value;
  return value.map((item) => {
    return isFormationExpression(item) ? '*' : item;
  });
};

/** The template's `events`, `event_pattern` spelling included. */
const templateEvents = (properties: Record<string, unknown>) => {
  return readTriggerEvents({
    events: toNullableArray<string>(properties.events),
    eventPattern: toNullableString(properties.event_pattern),
  });
};

/**
 * Reuses the transport-independent business rules from the lib so formation
 * templates enforce the same invariants as the REST API (cron iff schedule,
 * events iff event, action iff tool, and a parseable 5-field UTC cron). Only meaningful once the
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
      events: shapeListValue(
        properties.events ??
          (properties.event_pattern == null
            ? undefined
            : [properties.event_pattern])
      ),
      eventResources: shapeListValue(properties.event_resources),
      eventData: properties.event_data,
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

export const triggersFormationModule = defineFormationModule({
  resourceType: 'trigger',
  authorization: {
    srnResourceType: 'trigger',
    create: 'triggers:CreateTrigger',
    update: 'triggers:UpdateTrigger',
    delete: 'triggers:DeleteTrigger',
    references: (properties) => {
      if (!isObjectRecord(properties)) return [];
      return secretRefIds(properties.tool_context).map((resourceId) => {
        return {
          action: SECRET_USE_ACTION,
          srnResourceType: 'secret',
          resourceId,
        };
      });
    },
  },

  extraChecks: (args) => {
    pushShapeRuleErrors(args);
    pushStringBagValueErrors({ ...args, field: 'tool_context' });
  },

  create: async ({ properties, projectId, actor }) => {
    // `createdByUserId` is the run-as identity a firing mints a token for, not
    // attribution: the deploying caller, so a firing can never exceed whoever
    // declared the trigger.
    return createTrigger({
      projectId,
      createdByUserId: actor.userId,
      policyIds: toNullableArray<string>(properties.policy_ids) ?? undefined,
      name: properties.name as string,
      description: toOptionalString(properties.description) ?? undefined,
      type: properties.type as string,
      targetType: properties.target_type as string,
      targetId: properties.target_id as string,
      action: toOptionalString(properties.action) ?? undefined,
      input: toInputObject(properties.input),
      toolContext: toStoredToolContext(properties.tool_context),
      cron: toOptionalString(properties.cron) ?? undefined,
      events: templateEvents(properties) ?? undefined,
      eventResources:
        toNullableArray<string>(properties.event_resources) ?? undefined,
      eventData: toEventData(properties.event_data) ?? undefined,
      active: toOptionalBoolean(properties.active),
      isAllowed: actor.isAllowed,
      writerPolicies: actor.getPolicies,
    });
  },

  update: async ({ properties, physicalResourceId, actor }) => {
    await updateTrigger({
      id: physicalResourceId,
      policyIds: toNullableArray<string>(properties.policy_ids) ?? undefined,
      name: toOptionalString(properties.name),
      description: toNullableString(properties.description),
      targetType: toOptionalString(properties.target_type),
      targetId: toOptionalString(properties.target_id),
      action: toNullableString(properties.action),
      input: toInputObject(properties.input),
      toolContext: toStoredToolContext(properties.tool_context),
      cron: toNullableString(properties.cron),
      events: templateEvents(properties),
      eventResources: toNullableArray<string>(properties.event_resources),
      eventData: toEventData(properties.event_data),
      active: toOptionalBoolean(properties.active),
      isAllowed: actor.isAllowed,
      writerPolicies: actor.getPolicies,
    });
  },

  remove: ({ physicalResourceId }) => {
    return deleteTrigger({ id: physicalResourceId });
  },

  fetch: ({ physicalResourceId }) => {
    return findTrigger({ id: physicalResourceId });
  },

  // Declared with no `getAttributes` behind it: the signing secret is what a
  // firing is authenticated with, and an output is readable by anyone holding
  // `formations:GetFormation`. Naming it here is what makes the refusal say
  // which attribute and why, instead of "attribute not found".
  sensitiveAttributes: ['secret'],

  // `findTrigger` never returns the bag, so a live-read diff can never confirm
  // it matches the template: without this, `plan-formation` compares the
  // declared value against a key that is always absent and reports `update`
  // forever, and applying it a second time would silently keep the first
  // apply's raw value in `lastAppliedProperties` to make that diff agree.
  writeOnlyProperties: ['tool_context'],
});
