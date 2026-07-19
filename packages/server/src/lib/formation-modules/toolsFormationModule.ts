import createDebug from 'debug';

import { DomainError } from '../../errors';
import { isRef } from '../formationsHelpers';
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
import { findInvalidTemplateTokens } from '../secrets';
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

// The lib `createTool` args are `undefined`-absent, while the normalizers yield
// `null`-absent — bridge the two without a `??` at every call site (keeps
// `create` under the per-function complexity budget).
const optional = <T>(value: T | null): T | undefined => {
  return value ?? undefined;
};

// ── Property validation ──────────────────────────────────────────────────

// A pipeline step's `tool_id` may be a formation `{ ref: ResourceName }`
// reference, which is resolved to the physical tool id at deploy time (by
// `resolveRefs`, after the referenced tool is created first per the dependency
// graph). Structural validation via `validatePipelineConfig` requires a string
// `tool_id`, so replace any ref-shaped `tool_id` with a placeholder before
// validating — this checks the rest of the pipeline shape without rejecting a
// legitimate reference. The referenced resource's existence is already checked
// by the template-wide ref validation in `formationsValidation`.
const REF_TOOL_ID_PLACEHOLDER = '__formation_ref__';

const normalizePipelineRefsForValidation = (pipeline: unknown): unknown => {
  if (!isObjectRecord(pipeline) || !Array.isArray(pipeline.steps)) {
    return pipeline;
  }
  return {
    ...pipeline,
    steps: pipeline.steps.map((step) => {
      if (!isObjectRecord(step)) return step;
      const rawToolId = step.tool_id ?? step.toolId;
      if (!isRef(rawToolId)) return step;
      const { toolId: _toolId, ...rest } = step;
      void _toolId;
      return { ...rest, tool_id: REF_TOOL_ID_PLACEHOLDER };
    }),
  };
};

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
      validatePipelineConfig(
        normalizePipelineRefsForValidation(properties.pipeline)
      );
    } catch (error) {
      const message =
        error instanceof DomainError ? error.message : String(error);
      errors.push({ path: `${basePath}.pipeline`, message });
    }
  }

  // Validate execute and mcp separately so each error points at the field
  // that actually carries the offending token.
  for (const field of ['execute', 'mcp'] as const) {
    const invalidTokens = findInvalidTemplateTokens(properties[field]);
    for (const token of new Set(invalidTokens)) {
      errors.push({
        path: `${basePath}.${field}`,
        message: `Invalid template token '${token}' — double curly braces are reserved for {{secret:sec_...}} references; use single braces ({param}) for URL path parameters.`,
      });
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
      description: optional(toNullableString(properties.description)),
      parameters: optional(toNullableObject(properties.parameters)),
      execute: optional(toNullableObject(properties.execute)),
      mcp: optional(toNullableObject(properties.mcp)),
      actions: optional(toNullableArray<string>(properties.actions)),
      deniedActions: optional(
        toNullableArray<string>(properties.denied_actions)
      ),
      presetParameters: optional(
        toNullableObject(properties.preset_parameters)
      ),
      pipeline: optional(toNullableObject(properties.pipeline)),
      discussionId: toOptionalString(properties.discussion_id),
      outputMapping: optional(toNullableObject(properties.output_mapping)),
      guardrailIds: optional(toNullableArray<string>(properties.guardrail_ids)),
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
      deniedActions: toNullableArray<string>(properties.denied_actions),
      presetParameters: toNullableObject(properties.preset_parameters),
      pipeline: toNullableObject(properties.pipeline),
      discussionId: toNullableString(properties.discussion_id),
      outputMapping: toNullableObject(properties.output_mapping),
      guardrailIds: toNullableArray<string>(properties.guardrail_ids),
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
        denied_actions: tool.deniedActions,
        preset_parameters: tool.presetParameters,
        pipeline: tool.pipeline,
        discussion_id: tool.discussionId,
        output_mapping: tool.outputMapping,
        guardrail_ids: tool.guardrailIds,
      };
    } catch {
      return null;
    }
  },
};
