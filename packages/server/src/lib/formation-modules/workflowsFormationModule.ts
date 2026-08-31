import {
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
import { defineFormationModule } from './defineFormationModule';

// `states`/`transitions` are stored camelCase but authored snake_case. The
// conversion lives in `workflowsValidation.ts`, shared with `rest/v1/workflows.ts`.

export const workflowsFormationModule = defineFormationModule({
  resourceType: 'workflow',

  create: ({ properties, projectId }) => {
    return createWorkflow({
      projectId,
      name: properties.name as string,
      description: toNullableString(properties.description),
      // Both are required and schema-checked before reaching here, so the
      // converter cannot return undefined and a `?? []` default would be an
      // unreachable branch.
      states: toCamelCollection<WorkflowState>(
        properties.states
      ) as WorkflowState[],
      transitions: toCamelCollection<WorkflowTransition>(
        properties.transitions
      ) as WorkflowTransition[],
      payloadSchema: toNullableObject(properties.payload_schema),
    });
  },

  update: async ({ properties, physicalResourceId }) => {
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
  },

  remove: ({ physicalResourceId }) => {
    return deleteWorkflow({ id: physicalResourceId });
  },

  fetch: ({ physicalResourceId }) => {
    return findWorkflow({ id: physicalResourceId });
  },

  read: (workflow) => {
    return {
      name: workflow.name,
      description: workflow.description,
      states: toSnakeCollection(workflow.states),
      transitions: toSnakeCollection(workflow.transitions),
      payload_schema: workflow.payload_schema,
    };
  },
});
