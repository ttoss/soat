import type { ValidationError } from '../formationsTypes';
import {
  toNullableArray,
  toNullableRecord,
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
  holdsFormationExpression,
  isObjectRecord,
  pushStringBagValueErrors,
} from './formationSpecLoader';

/** Narrows an untyped template value to a plain input object, else undefined. */
const toInputObject = (value: unknown): Record<string, unknown> | undefined => {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
};

const toOptionalBoolean = (value: unknown): boolean | undefined => {
  return value != null ? Boolean(value) : undefined;
};

type ShapeField = Exclude<
  keyof Parameters<typeof validateTriggerShape>[0],
  'type' | 'targetType'
>;

/**
 * What each shape field reads as while it holds a `ref`/`param`/`sub`
 * anywhere: present, and passing the checks of its literal kind. The shape
 * error is reported on the resource, not the field, so the validator cannot
 * drop it; the apply re-runs the shape on the resolved value.
 */
const SHAPE_PLACEHOLDERS: Record<ShapeField, unknown> = {
  action: '<expression>',
  cron: '<expression>',
  events: ['*'],
  eventResources: ['*'],
  eventData: {},
};

const shapeValue = (args: { field: ShapeField; value: unknown }): unknown => {
  return holdsFormationExpression(args.value)
    ? SHAPE_PLACEHOLDERS[args.field]
    : args.value;
};

const shapeString = (args: {
  field: 'action' | 'cron';
  value: unknown;
}): string | null => {
  const value = shapeValue(args);
  return toNullableString(value) ?? null;
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
      action: shapeString({ field: 'action', value: properties.action }),
      cron: shapeString({ field: 'cron', value: properties.cron }),
      events: shapeValue({
        field: 'events',
        value:
          properties.events ??
          (properties.event_pattern == null
            ? undefined
            : [properties.event_pattern]),
      }),
      eventResources: shapeValue({
        field: 'eventResources',
        value: properties.event_resources,
      }),
      eventData: shapeValue({
        field: 'eventData',
        value: properties.event_data,
      }),
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
    return createTrigger({
      projectId,
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
      eventData: toNullableRecord(properties.event_data) ?? undefined,
      active: toOptionalBoolean(properties.active),
      writer: actor,
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
      input: toNullableRecord(properties.input),
      toolContext: toStoredToolContext(properties.tool_context),
      cron: toNullableString(properties.cron),
      events: templateEvents(properties),
      eventResources: toNullableArray<string>(properties.event_resources),
      eventData: toNullableRecord(properties.event_data),
      active: toOptionalBoolean(properties.active),
      writer: actor,
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
