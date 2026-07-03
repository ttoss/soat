import createDebug from 'debug';

import type { FormationModule, ValidationError } from '../formationsTypes';
import type { OrchestrationEdge, OrchestrationNode } from '../orchestrations';
import {
  createOrchestration,
  deleteOrchestration,
  findOrchestration,
  updateOrchestration,
} from '../orchestrations';
import {
  toNullableObject,
  toNullableString,
  toOptionalString,
} from '../resource-inputs/normalizers';
import {
  isObjectRecord,
  loadModuleSpec,
  pushFieldTypeErrors,
  pushRequiredFieldErrors,
  pushUnknownFieldErrors,
} from './formationSpecLoader';

const log = createDebug('soat:formations:orchestrations');

const SCHEMA_NAME = 'OrchestrationResourceProperties';
const RESOURCE_LABEL = 'orchestration';

// ── Key normalization ────────────────────────────────────────────────────

const camelToSnakeKey = (key: string): string => {
  return key.replace(/[A-Z]/g, (char) => {
    return `_${char.toLowerCase()}`;
  });
};

const snakeToCamelKey = (key: string): string => {
  return key.replace(/_([a-z])/g, (_, char: string) => {
    return char.toUpperCase();
  });
};

const convertKeys = (
  obj: Record<string, unknown>,
  transform: (key: string) => string
): Record<string, unknown> => {
  return Object.fromEntries(
    Object.entries(obj).map(([key, value]) => {
      return [transform(key), value];
    })
  );
};

/**
 * Normalize the top-level property keys to snake_case so a template authored
 * with camelCase keys (e.g. `stateSchema`) validates against the snake_case
 * OpenAPI schema. Nested node/edge objects are left untouched here — they are
 * converted separately, key-by-key, only when a live orchestration is built.
 */
const normalizePropertyKeys = (
  properties: Record<string, unknown>
): Record<string, unknown> => {
  return convertKeys(properties, camelToSnakeKey);
};

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

// ── Property validation ──────────────────────────────────────────────────

const validateOrchestrationProperties = (args: {
  properties: unknown;
  basePath: string;
  forUpdate?: boolean;
}): ValidationError[] => {
  const { basePath, forUpdate } = args;
  if (!isObjectRecord(args.properties)) {
    return [
      {
        path: basePath,
        message: 'Orchestration `properties` must be an object',
      },
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

// ── Module export ────────────────────────────────────────────────────────

export const orchestrationsFormationModule: FormationModule = {
  resourceType: 'orchestration',

  validateProperties: ({ properties, basePath }) => {
    return validateOrchestrationProperties({ properties, basePath });
  },

  create: async ({ properties: rawProperties, projectId }) => {
    const errors = validateOrchestrationProperties({
      properties: rawProperties,
      basePath: 'resources.<orchestration>.properties',
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const properties = normalizePropertyKeys(rawProperties);

    const result = await createOrchestration({
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

    log(
      'created orchestration from formation: projectId=%d orchestrationId=%s',
      projectId,
      result.id
    );
    return result.id;
  },

  update: async ({ properties: rawProperties, physicalResourceId }) => {
    const errors = validateOrchestrationProperties({
      properties: rawProperties,
      basePath: 'resources.<orchestration>.properties',
      forUpdate: true,
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const properties = normalizePropertyKeys(rawProperties);

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

    log('updated orchestration from formation: id=%s', physicalResourceId);
  },

  delete: async ({ physicalResourceId }) => {
    await deleteOrchestration({ id: physicalResourceId });
    log('deleted orchestration from formation: id=%s', physicalResourceId);
  },

  read: async ({ physicalResourceId }) => {
    try {
      const orch = await findOrchestration({ id: physicalResourceId });
      if (!orch) return null;
      return {
        name: orch.name,
        description: orch.description,
        nodes: convertCollectionKeys(orch.nodes, camelToSnakeKey),
        edges: convertCollectionKeys(orch.edges, camelToSnakeKey),
        state_schema: orch.stateSchema,
        input_schema: orch.inputSchema,
      };
    } catch {
      return null;
    }
  },
};
