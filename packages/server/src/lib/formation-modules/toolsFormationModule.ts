import { DomainError } from '../../errors';
import { isRef } from '../formationsHelpers';
import type { ValidationError } from '../formationsTypes';
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
import { validateExecuteAuth } from '../toolAuth';
import { assertValidToolContextAllowlist } from '../toolContext';
import { createTool, deleteTool, getTool, updateTool } from '../tools';
import {
  describeToolTemplateTokenProblems,
  findInvalidTemplateTokens,
  findToolTemplateTokenProblems,
} from '../toolTemplates';
import { defineFormationModule } from './defineFormationModule';
import { isObjectRecord } from './formationSpecLoader';

// The lib `createTool` args are `undefined`-absent, while the normalizers yield
// `null`-absent — bridge the two without a `??` at every call site (keeps
// `create` under the per-function complexity budget).
const optional = <T>(value: T | null): T | undefined => {
  return value ?? undefined;
};

// A step's `tool_id` may be a `{ ref }` resolved only at deploy time, but
// `validatePipelineConfig` requires a string — so ref-shaped ids are swapped
// for a placeholder, checking the rest of the shape without rejecting a
// legitimate reference. The ref's target is validated template-wide elsewhere.
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

/**
 * Applies the same `execute.auth` rule the REST create/update paths enforce, so
 * a malformed credential config fails at `validate-formation` rather than
 * part-way through an apply.
 */
const pushExecuteAuthErrors = (args: {
  properties: Record<string, unknown>;
  basePath: string;
  errors: ValidationError[];
}): void => {
  try {
    validateExecuteAuth({ execute: args.properties.execute });
  } catch (error) {
    args.errors.push({
      path: `${args.basePath}.execute.auth`,
      message: error instanceof DomainError ? error.message : String(error),
    });
  }
};

export const toolsFormationModule = defineFormationModule({
  resourceType: 'tool',

  extraChecks: ({ properties, basePath, errors }) => {
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

    pushExecuteAuthErrors({ properties, basePath, errors });

    // The same rule the REST write path enforces, from the same function, so a
    // template cannot author a tool the API would reject — and so the error
    // arrives at `validate-formation` rather than part-way through an apply.
    try {
      assertValidToolContextAllowlist(properties.context_keys);
    } catch (error) {
      errors.push({
        path: `${basePath}.context_keys`,
        message: error instanceof DomainError ? error.message : String(error),
      });
    }

    // Separately, so each error points at the field carrying the offending
    // token. The rule comes from `toolTemplates`, as on the REST write path.
    for (const field of ['execute', 'mcp'] as const) {
      const message = describeToolTemplateTokenProblems(
        findToolTemplateTokenProblems(properties[field])
      );
      if (message) {
        errors.push({ path: `${basePath}.${field}`, message });
      }
    }

    // `preset_parameters` takes the shape rule only: a `{{context:...}}` token
    // is legitimate there (#345), so it is not run through the headers/elsewhere
    // split that decides "misplaced".
    const presetMessage = describeToolTemplateTokenProblems({
      invalid: findInvalidTemplateTokens(properties.preset_parameters),
      misplacedContext: [],
    });
    if (presetMessage) {
      errors.push({
        path: `${basePath}.preset_parameters`,
        message: presetMessage,
      });
    }
  },

  /**
   * Warns when a pipeline tool declares a `parameters` property that no step's
   * `input` mapping (nor the pipeline's `output` mapping) ever reads via
   * `{ var: 'input.<name>' }`. Such a caller-supplied value never reaches any
   * step — it is silently dropped rather than causing a runtime error — so
   * this is a warning, not a validation error.
   */
  warnChecks: ({ properties, basePath }) => {
    if (properties.type !== 'pipeline' || properties.pipeline === undefined) {
      return [];
    }

    let config;
    try {
      config = validatePipelineConfig(properties.pipeline);
    } catch {
      // Already reported by the validation checks; nothing more to warn about.
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
  },

  create: ({ properties, projectId }) => {
    return createTool({
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
      contextKeys: toNullableArray<string>(properties.context_keys),
      presetParameters: optional(
        toNullableObject(properties.preset_parameters)
      ),
      pipeline: optional(toNullableObject(properties.pipeline)),
      outputMapping: optional(toNullableObject(properties.output_mapping)),
      guardrailIds: optional(toNullableArray<string>(properties.guardrail_ids)),
    });
  },

  update: async ({ properties, physicalResourceId }) => {
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
      contextKeys: toNullableArray<string>(properties.context_keys),
      presetParameters: toNullableObject(properties.preset_parameters),
      pipeline: toNullableObject(properties.pipeline),
      outputMapping: toNullableObject(properties.output_mapping),
      guardrailIds: toNullableArray<string>(properties.guardrail_ids),
    });
  },

  remove: ({ physicalResourceId }) => {
    return deleteTool({ id: physicalResourceId });
  },

  fetch: ({ physicalResourceId }) => {
    return getTool({ id: physicalResourceId });
  },
});
