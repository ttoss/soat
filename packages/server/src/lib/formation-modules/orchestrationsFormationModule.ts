import type { OrchestrationEdge, OrchestrationNode } from '../orchestrations';
import {
  createOrchestration,
  deleteOrchestration,
  findOrchestration,
  updateOrchestration,
} from '../orchestrations';
import {
  camelToSnakeKey,
  convertKeys,
  snakeToCamelKey,
  toNullableObject,
  toNullableString,
  toOptionalString,
} from '../resource-inputs/normalizers';
import { defineFormationModule } from './defineFormationModule';
import { isObjectRecord } from './formationSpecLoader';

// ── Key normalization ────────────────────────────────────────────────────

/**
 * Orchestration nodes and edges are stored (and read by the engine) with
 * camelCase structural fields (`agentId`, `inputMapping`, `activationGroup`),
 * but formation templates — like the REST contract — use snake_case
 * (`agent_id`, `input_mapping`, `activation_group`). Convert each element's
 * own keys, leaving values verbatim: JSON Logic operators carry no underscores
 * and `var` references are string values, so mappings and expressions survive
 * untouched.
 */
const convertCollectionKeys = (
  value: unknown,
  transform: (key: string) => string
): unknown[] => {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    return isObjectRecord(item) ? convertKeys(item, transform) : item;
  });
};

export const orchestrationsFormationModule = defineFormationModule({
  resourceType: 'orchestration',

  create: ({ properties, projectId }) => {
    return createOrchestration({
      projectId,
      name: properties.name as string,
      description: toNullableString(properties.description),
      nodes: convertCollectionKeys(
        properties.nodes,
        snakeToCamelKey
      ) as OrchestrationNode[],
      edges: convertCollectionKeys(
        properties.edges,
        snakeToCamelKey
      ) as OrchestrationEdge[],
      stateSchema: toNullableObject(properties.state_schema),
      inputSchema: toNullableObject(properties.input_schema),
    });
  },

  update: async ({ properties, physicalResourceId }) => {
    await updateOrchestration({
      id: physicalResourceId,
      name: toOptionalString(properties.name),
      description: toNullableString(properties.description),
      nodes:
        properties.nodes !== undefined
          ? (convertCollectionKeys(
              properties.nodes,
              snakeToCamelKey
            ) as OrchestrationNode[])
          : undefined,
      edges:
        properties.edges !== undefined
          ? (convertCollectionKeys(
              properties.edges,
              snakeToCamelKey
            ) as OrchestrationEdge[])
          : undefined,
      stateSchema: toNullableObject(properties.state_schema),
      inputSchema: toNullableObject(properties.input_schema),
    });
  },

  remove: ({ physicalResourceId }) => {
    return deleteOrchestration({ id: physicalResourceId });
  },

  fetch: ({ physicalResourceId }) => {
    return findOrchestration({ id: physicalResourceId });
  },

  read: (orch) => {
    return {
      name: orch.name,
      description: orch.description,
      nodes: convertCollectionKeys(orch.nodes, camelToSnakeKey),
      edges: convertCollectionKeys(orch.edges, camelToSnakeKey),
      state_schema: orch.state_schema,
      input_schema: orch.input_schema,
    };
  },
});
