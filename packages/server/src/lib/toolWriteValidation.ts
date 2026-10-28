import type { db } from '../db';
import { DomainError } from '../errors';
import { validateHttpExecute } from './httpToolResponse';
import {
  assertPipelineStepToolsValid,
  validatePipelineConfig,
} from './pipelineTools';
import { assertSecretRefsExist } from './secrets';
import { validateSoatActions } from './soatActionValidation';
import { assertValidToolContextAllowlist } from './toolContext';
import { assertNoLiteralCredentials } from './toolSecretRedaction';
import { assertValidToolTemplateTokens } from './toolTemplates';

/**
 * The complete set of tool types the server can resolve and execute. An
 * unlisted type has no resolver branch, so it would silently vanish from an
 * agent's toolset and fail at call time with a misleading error — reject it at
 * write time instead.
 */
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
  actions?: string[] | null;
  deniedActions?: string[] | null;
  contextKeys?: string[] | null;
  presetParameters?: object | null;
  pipeline?: object | null;
  outputMapping?: object | null;
  guardrailIds?: string[] | null;
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
  if (!touchesConfig && args.presetParameters === undefined) return;

  assertValidToolTemplateTokens({
    execute: args.execute,
    mcp: args.mcp,
    presetParameters: args.presetParameters,
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
  await validateToolUpdateTemplates({ args, projectId: tool.projectId });
};
