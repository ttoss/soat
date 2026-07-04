import createDebug from 'debug';

import { DomainError } from '../../errors';
import type { FormationModule, ValidationError } from '../formationsTypes';
import {
  findUnreferencedPipelineParams,
  validatePipelineConfig,
} from '../pipelineTools';
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

  if (properties.type === 'pipeline' && properties.pipeline !== undefined) {
    try {
      validatePipelineConfig(properties.pipeline);
    } catch (error) {
      const message =
        error instanceof DomainError ? error.message : String(error);
      errors.push({ path: `${basePath}.pipeline`, message });
    }
  }

  return errors;
};

/**
 * Warns when a pipeline tool declares a `parameters` property that no step's
 * `input` mapping (nor the pipeline's `output` mapping) ever reads via
 * `{ var: 'input.<name>' }`. Such a caller-supplied value never reaches any
 * step — it is silently dropped rather than causing a runtime error — so
 * this is a warning, not a validation error.
 */
const warnToolProperties = (args: {
  properties: unknown;
  basePath: string;
}): ValidationError[] => {
  const { properties, basePath } = args;
  if (!isObjectRecord(properties)) return [];
  if (properties.type !== 'pipeline' || properties.pipeline === undefined) {
    return [];
  }

  let config;
  try {
    config = validatePipelineConfig(properties.pipeline);
  } catch {
    // Already reported by validateToolProperties; nothing more to warn about.
    return [];
  }

  const unreferenced = findUnreferencedPipelineParams({
    config,
    parameters: properties.parameters,
  });

  return unreferenced.map((name) => {
    return {
      path: `${basePath}.pipeline`,
      message: `Pipeline parameter '${name}' is declared but never referenced by any step's \`input\` (or the pipeline \`output\`) as \`{ "var": "input.${name}" }\` — it will never reach a step.`,
    };
  });
};

// ── Module export ────────────────────────────────────────────────────────

export const toolsFormationModule: FormationModule = {
  resourceType: 'tool',

  validateProperties: ({ properties, basePath }) => {
    return validateToolProperties({ properties, basePath });
  },

  warnProperties: ({ properties, basePath }) => {
    return warnToolProperties({ properties, basePath });
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
      pipeline: toNullableObject(properties.pipeline) ?? undefined,
      outputMapping: toNullableObject(properties.output_mapping) ?? undefined,
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
      pipeline: toNullableObject(properties.pipeline),
      outputMapping: toNullableObject(properties.output_mapping),
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
        pipeline: tool.pipeline,
        output_mapping: tool.outputMapping,
      };
    } catch {
      return null;
    }
  },
};
