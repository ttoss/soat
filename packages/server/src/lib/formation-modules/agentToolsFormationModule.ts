import createDebug from 'debug';

import {
  createAgentTool,
  deleteAgentTool,
  updateAgentTool,
} from '../agentToolsCrud';
import type { FormationModule, ValidationError } from '../formationsTypes';
import {
  toNullableArray,
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

const log = createDebug('soat:formations:agentTools');

const SCHEMA_NAME = 'AgentToolResourceProperties';
const RESOURCE_LABEL = 'agent_tool';

// ── Property validation ──────────────────────────────────────────────────

const validateAgentToolProperties = (args: {
  properties: unknown;
  basePath: string;
  forUpdate?: boolean;
}): ValidationError[] => {
  const { properties, basePath, forUpdate } = args;
  if (!isObjectRecord(properties)) {
    return [
      {
        path: basePath,
        message: 'Agent tool `properties` must be an object',
      },
    ];
  }

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

export const agentToolsFormationModule: FormationModule = {
  resourceType: 'agent_tool',

  validateProperties: ({ properties, basePath }) => {
    return validateAgentToolProperties({ properties, basePath });
  },

  create: async ({ properties, projectId }) => {
    const errors = validateAgentToolProperties({
      properties,
      basePath: 'resources.<agent_tool>.properties',
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const result = await createAgentTool({
      projectId,
      name: properties.name as string,
      type: toOptionalString(properties.type),
      description: toNullableString(properties.description) ?? undefined,
      parameters: toNullableObject(properties.parameters) ?? undefined,
      execute: toNullableObject(properties.execute) ?? undefined,
      mcp: toNullableObject(properties.mcp) ?? undefined,
      actions: toNullableArray<string>(properties.actions) ?? undefined,
      presetParameters:
        toNullableObject(properties.preset_parameters) ?? undefined,
    });

    log(
      'created agent tool from formation: projectId=%d toolId=%s',
      projectId,
      result.id
    );
    return result.id;
  },

  update: async ({ properties, physicalResourceId }) => {
    const errors = validateAgentToolProperties({
      properties,
      basePath: 'resources.<agent_tool>.properties',
      forUpdate: true,
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    await updateAgentTool({
      id: physicalResourceId,
      name: toOptionalString(properties.name),
      type: toOptionalString(properties.type),
      description: toNullableString(properties.description),
      parameters: toNullableObject(properties.parameters),
      execute: toNullableObject(properties.execute),
      mcp: toNullableObject(properties.mcp),
      actions: toNullableArray<string>(properties.actions),
      presetParameters: toNullableObject(properties.preset_parameters),
    });
  },

  delete: async ({ physicalResourceId }) => {
    await deleteAgentTool({ id: physicalResourceId });
  },
};
