import createDebug from 'debug';

import type { FormationModule, ValidationError } from '../formationsTypes';
import {
  toNullableArray,
  toNullableObject,
  toNullableString,
  toOptionalString,
} from '../resource-inputs/normalizers';
import { createTool, deleteTool, getTool, updateTool } from '../tools';
import {
  isObjectRecord,
  loadModuleSpec,
  pushFieldTypeErrors,
  pushRequiredFieldErrors,
  pushUnknownFieldErrors,
} from './formationSpecLoader';

const log = createDebug('soat:formations:tools');

const SCHEMA_NAME = 'ToolResourceProperties';
const RESOURCE_LABEL = 'tool';

// ── Property validation ──────────────────────────────────────────────────

const validateToolProperties = (args: {
  properties: unknown;
  basePath: string;
  forUpdate?: boolean;
}): ValidationError[] => {
  const { properties, basePath, forUpdate } = args;
  if (!isObjectRecord(properties)) {
    return [
      {
        path: basePath,
        message: 'Tool `properties` must be an object',
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

export const toolsFormationModule: FormationModule = {
  resourceType: 'tool',

  validateProperties: ({ properties, basePath }) => {
    return validateToolProperties({ properties, basePath });
  },

  create: async ({ properties, projectId }) => {
    const errors = validateToolProperties({
      properties,
      basePath: 'resources.<tool>.properties',
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const result = await createTool({
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
      'created tool from formation: projectId=%d toolId=%s',
      projectId,
      result.id
    );
    return result.id;
  },

  update: async ({ properties, physicalResourceId }) => {
    const errors = validateToolProperties({
      properties,
      basePath: 'resources.<tool>.properties',
      forUpdate: true,
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    await updateTool({
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
    await deleteTool({ id: physicalResourceId });
  },

  read: async ({ physicalResourceId }) => {
    try {
      const tool = await getTool({ id: physicalResourceId });
      return {
        name: tool.name,
        type: tool.type,
        description: tool.description,
        parameters: tool.parameters,
        execute: tool.execute,
        mcp: tool.mcp,
        actions: tool.actions,
        preset_parameters: tool.presetParameters,
      };
    } catch {
      return null;
    }
  },
};
