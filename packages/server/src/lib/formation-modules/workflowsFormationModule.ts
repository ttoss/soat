import createDebug from 'debug';

import type { FormationModule, ValidationError } from '../formationsTypes';
import {
  normalizePropertyKeys,
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
  workflowCollectionToCamel as toCamelCollection,
  workflowCollectionToSnake as toSnakeCollection,
} from '../workflowsValidation';
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
//
// A workflow's `states` and `transitions` are stored (and read by the engine)
// with camelCase structural keys, but authored and read back snake_case on
// the wire. The deep conversion (leaving JSON-Logic `guard`/`when` bodies
// verbatim) lives in `workflowsValidation.ts`, shared with `rest/v1/workflows.ts`.

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
        payload_schema: workflow.payload_schema,
      };
    } catch {
      return null;
    }
  },
};
