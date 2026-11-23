import createDebug from 'debug';

import type { db } from '../db';
import { DomainError } from '../errors';
import { assertBuiltinPresetsDeclared } from './builtinPresetValidation';
import { validateHttpExecute } from './httpToolResponse';
import {
  assertPipelineStepToolsValid,
  validatePipelineConfig,
} from './pipelineTools';
import { assertSecretRefsExist } from './secrets';
import { validateSoatActions } from './soatActionValidation';
import { assertValidToolContextAllowlist } from './toolContext';
import type { InlineToolDefinition } from './toolsCall';
import { assertNoLiteralCredentials } from './toolSecretRedaction';
import { assertValidToolTemplateTokens } from './toolTemplates';

/**
 * The complete set of tool types the server can resolve and execute. An
 * unlisted type has no resolver branch, so it would silently vanish from an
 * agent's toolset and fail at call time with a misleading error — reject it at
 * write time instead.
 */
const log = createDebug('soat:tools');

const TOOL_TYPES = ['http', 'client', 'mcp', 'builtin', 'pipeline'] as const;

export const assertToolTypeSupported = (type: string): void => {
  if (!(TOOL_TYPES as readonly string[]).includes(type)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `Unsupported tool type '${type}'. Supported types: ${TOOL_TYPES.join(', ')}.`
    );
  }
};

export type ToolUpdateArgs = {
  projectIds?: number[];
  id: string;
  type?: string;
  name?: string;
  description?: string | null;
  parameters?: object | null;
  execute?: object | null;
  mcp?: object | null;
  /** Only `null`, which clears the pins. */
  mcpPins?: null;
  actions?: string[] | null;
  deniedActions?: string[] | null;
  contextKeys?: string[] | null;
  presetParameters?: object | null;
  presetParametersByAction?: object | null;
  pipeline?: object | null;
  outputMapping?: object | null;
  guardrailIds?: string[] | null;
  trustedOutput?: boolean;
};

/**
 * The template-token and credential checks for an update, over whichever of the
 * three token-bearing fields the PATCH actually touches.
 *
 * `preset_parameters` is checked on its own, not only alongside an `execute` /
 * `mcp` change: a PATCH that touches nothing but the presets is exactly the
 * write that introduces a malformed token there.
 */
const validateToolUpdateTemplates = async (params: {
  args: ToolUpdateArgs;
  projectId: number;
}): Promise<void> => {
  const { args } = params;
  const touchesConfig = args.execute !== undefined || args.mcp !== undefined;
  if (
    !touchesConfig &&
    args.presetParameters === undefined &&
    args.presetParametersByAction === undefined
  ) {
    return;
  }

  assertValidToolTemplateTokens({
    execute: args.execute,
    mcp: args.mcp,
    presetParameters: args.presetParameters,
    presetParametersByAction: args.presetParametersByAction,
  });
  if (touchesConfig) {
    await assertSecretRefsExist({
      value: { execute: args.execute, mcp: args.mcp },
      projectId: params.projectId,
    });
  }
};

/**
 * Checked against the tool the write leaves behind, so switching to `http` or
 * clearing `execute` cannot leave an http tool without a target.
 */
const validateUpdatedExecute = (params: {
  args: ToolUpdateArgs;
  tool: InstanceType<typeof db.Tool>;
}): void => {
  const { args, tool } = params;
  if (args.type === undefined && args.execute === undefined) return;
  validateHttpExecute({
    type: args.type ?? tool.type,
    execute: args.execute === undefined ? tool.execute : args.execute,
  });
};

/**
 * Checked against the tool the write leaves behind, so a new action is held to
 * the presets already stored.
 */
const validateUpdatedPresets = (params: {
  args: ToolUpdateArgs;
  tool: InstanceType<typeof db.Tool>;
}): void => {
  const { args, tool } = params;
  const pick = <K extends keyof ToolUpdateArgs & keyof typeof tool>(key: K) => {
    return args[key] === undefined ? tool[key] : args[key];
  };
  assertBuiltinPresetsDeclared({
    type: args.type ?? tool.type,
    actions: pick('actions'),
    deniedActions: pick('deniedActions'),
    presetParameters: pick('presetParameters'),
    presetParametersByAction: pick('presetParametersByAction'),
  });
};

/** Runs the per-type validation for an update against the existing tool row. */
export const validateToolUpdate = async (params: {
  args: ToolUpdateArgs;
  tool: InstanceType<typeof db.Tool>;
}): Promise<void> => {
  const { args, tool } = params;
  if (args.type !== undefined) {
    assertToolTypeSupported(args.type);
  }
  assertNoLiteralCredentials(args);
  if (args.pipeline !== undefined && args.pipeline !== null) {
    const config = validatePipelineConfig(args.pipeline);
    await assertPipelineStepToolsValid({
      steps: config.steps,
      projectId: tool.projectId,
    });
  }
  if (args.actions !== undefined && (args.type ?? tool.type) === 'builtin') {
    validateSoatActions(args.actions);
  }
  if (args.contextKeys !== undefined) {
    assertValidToolContextAllowlist(args.contextKeys);
  }
  validateUpdatedExecute({ args, tool });
  validateUpdatedPresets({ args, tool });
  await validateToolUpdateTemplates({ args, projectId: tool.projectId });
};

export const validateToolDefinition = async (args: {
  definition: InlineToolDefinition;
  projectId: number;
}): Promise<void> => {
  const { definition, projectId } = args;

  log(
    'validateToolDefinition: projectId=%d name=%s type=%s',
    projectId,
    definition.name,
    definition.type ?? 'http'
  );

  if (!definition.name || typeof definition.name !== 'string') {
    throw new DomainError(
      'VALIDATION_FAILED',
      'Tool definition requires a name.'
    );
  }

  assertToolTypeSupported(definition.type ?? 'http');
  assertNoLiteralCredentials(definition);

  if (definition.type === 'pipeline') {
    const config = validatePipelineConfig(definition.pipeline);
    await assertPipelineStepToolsValid({
      steps: config.steps,
      projectId,
    });
  }

  if ((definition.type ?? 'http') === 'builtin') {
    validateSoatActions(definition.actions);
  }

  validateHttpExecute({
    type: definition.type ?? 'http',
    execute: definition.execute,
  });

  // A `context_keys` entry is a `tool_context` key, held to the same
  // header-name grammar (`toolContext.ts`) so an entry cannot be one that no
  // key could ever match.
  assertValidToolContextAllowlist(definition.contextKeys);

  // Reject any {{...}} token that isn't a well-formed reference — and any
  // {{context:...}} token outside a headers record — before checking whether
  // referenced secrets actually exist.
  assertValidToolTemplateTokens({
    execute: definition.execute,
    mcp: definition.mcp,
    presetParameters: definition.presetParameters,
    presetParametersByAction: definition.presetParametersByAction,
  });
  assertBuiltinPresetsDeclared({
    type: definition.type ?? 'http',
    actions: definition.actions,
    deniedActions: definition.deniedActions,
    presetParameters: definition.presetParameters,
    presetParametersByAction: definition.presetParametersByAction,
  });

  // Fail fast on {{secret:...}} tokens referencing nonexistent or
  // out-of-project secrets, instead of failing at first call.
  await assertSecretRefsExist({
    value: { execute: definition.execute, mcp: definition.mcp },
    projectId,
  });
};
