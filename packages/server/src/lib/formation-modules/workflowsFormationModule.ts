import createDebug from 'debug';

import type { FormationModule, ValidationError } from '../formationsTypes';
import {
  camelToSnakeKey,
  isPlainObject,
  normalizePropertyKeys,
  snakeToCamelKey,
  toNullableObject,
  toNullableString,
  toOptionalString,
} from '../resource-inputs/normalizers';
import {
  createWorkflow,
  deleteWorkflow,
  findWorkflow,
  updateWorkflow,
  type WorkflowState,
  type WorkflowTransition,
} from '../workflows';
import {
  isObjectRecord,
  loadModuleSpec,
  pushFieldTypeErrors,
  pushRequiredFieldErrors,
  pushUnknownFieldErrors,
} from './formationSpecLoader';

const log = createDebug('soat:formations:workflows');

const SCHEMA_NAME = 'WorkflowResourceProperties';
const RESOURCE_LABEL = 'workflow';

// ── Key normalization ────────────────────────────────────────────────────

// A workflow's `states` and `transitions` are stored (and read by the engine)
// with camelCase structural keys (`stalledAfter`, `onEnter`, `onComplete`,
// `requiresApproval`, `agentId`) — the case-transform middleware converts the
// snake_case REST contract inbound. Formation templates author the same
// snake_case contract, but the property bag is only shallow-normalized, so the
// nested state/transition keys arrive snake_cased. Mirror caseTransform exactly:
// deep-convert every key while leaving the raw JSON-Logic bodies (`guard` on a
// transition, `when` on an on_complete rule) verbatim — their inner keys are
// author-authored data, not SOAT field names.
const JSON_LOGIC_KEYS = new Set(['guard', 'when']);

const deepConvertKeys = (
  value: unknown,
  transform: (key: string) => string
): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => {
      return deepConvertKeys(item, transform);
    });
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => {
        const newKey = transform(key);
        if (JSON_LOGIC_KEYS.has(newKey)) {
          // Pass-through: a guard/when body round-trips with its author-authored
          // inner keys intact, exactly like caseTransform's skip list.
          return [newKey, val];
        }
        return [newKey, deepConvertKeys(val, transform)];
      })
    );
  }
  return value;
};

const toCamelCollection = <T>(value: unknown): T[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  return deepConvertKeys(value, snakeToCamelKey) as T[];
};

const toSnakeCollection = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) return [];
  return deepConvertKeys(value, camelToSnakeKey) as unknown[];
};

// ── Property validation ──────────────────────────────────────────────────

const validateWorkflowProperties = (args: {
  properties: unknown;
  basePath: string;
  forUpdate?: boolean;
}): ValidationError[] => {
  const { basePath, forUpdate } = args;
  if (!isObjectRecord(args.properties)) {
    return [
      { path: basePath, message: 'Workflow `properties` must be an object' },
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

// ── Module export ──────────────────────────────────────────────────────────

export const workflowsFormationModule: FormationModule = {
  resourceType: 'workflow',

  validateProperties: ({ properties, basePath }) => {
    return validateWorkflowProperties({ properties, basePath });
  },

  create: async ({ properties: rawProperties, projectId }) => {
    const errors = validateWorkflowProperties({
      properties: rawProperties,
      basePath: 'resources.<workflow>.properties',
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const properties = normalizePropertyKeys(rawProperties);

    const result = await createWorkflow({
      projectId,
      name: properties.name as string,
      description: toNullableString(properties.description),
      states: (toCamelCollection<WorkflowState>(properties.states) ??
        []) as WorkflowState[],
      transitions: (toCamelCollection<WorkflowTransition>(
        properties.transitions
      ) ?? []) as WorkflowTransition[],
      payloadSchema: toNullableObject(properties.payload_schema),
    });

    log(
      'created workflow from formation: projectId=%d workflowId=%s',
      projectId,
      result.id
    );
    return result.id;
  },

  update: async ({ properties: rawProperties, physicalResourceId }) => {
    const errors = validateWorkflowProperties({
      properties: rawProperties,
      basePath: 'resources.<workflow>.properties',
      forUpdate: true,
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const properties = normalizePropertyKeys(rawProperties);

    await updateWorkflow({
      id: physicalResourceId,
      name: toOptionalString(properties.name),
      description: toNullableString(properties.description),
      states: toCamelCollection<WorkflowState>(properties.states),
      transitions: toCamelCollection<WorkflowTransition>(
        properties.transitions
      ),
      payloadSchema: toNullableObject(properties.payload_schema),
    });

    log('updated workflow from formation: id=%s', physicalResourceId);
  },

  delete: async ({ physicalResourceId }) => {
    await deleteWorkflow({ id: physicalResourceId });
    log('deleted workflow from formation: id=%s', physicalResourceId);
  },

  read: async ({ physicalResourceId }) => {
    try {
      const workflow = await findWorkflow({ id: physicalResourceId });
      if (!workflow) return null;
      return {
        name: workflow.name,
        description: workflow.description,
        states: toSnakeCollection(workflow.states),
        transitions: toSnakeCollection(workflow.transitions),
        payload_schema: workflow.payloadSchema,
      };
    } catch {
      return null;
    }
  },
};
