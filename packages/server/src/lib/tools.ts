import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { assertGuardrailsExist } from './guardrails';
import {
  assertPipelineStepToolsValid,
  validatePipelineConfig,
} from './pipelineTools';
import {
  assertNoInvalidTemplateTokens,
  assertSecretRefsExist,
} from './secrets';
import { soatTools } from './soatTools';
import { callResolvedTool, type InlineToolDefinition } from './toolsCall';

const log = createDebug('soat:tools');

// Re-exported so existing importers of `assertEphemeralTypeSupported`,
// `callEphemeralTool`, and `InlineToolDefinition` (agents.ts, pipelineTools.ts,
// agentToolResolver.ts) can keep importing them from this module.
export {
  assertEphemeralTypeSupported,
  type CallableToolDefinition,
  callEphemeralTool,
  type InlineToolDefinition,
} from './toolsCall';

// ── SOAT Action Validation ──────────────────────────────────────────────────

const KNOWN_SOAT_ACTIONS = new Set(
  soatTools.map((tool) => {
    return tool.name;
  })
);

// SOAT action names are kebab-case (e.g. "search-knowledge"), matching the MCP
// tool name derived from the OpenAPI operationId. A common mistake is passing
// the operationId itself (camelCase, e.g. "searchKnowledge") — detect that case
// and suggest the correct kebab-case name.
const camelToKebab = (value: string): string => {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
};

export const validateSoatActions = (actions: string[] | null | undefined) => {
  if (!actions) return;
  const unknown = actions.filter((action) => {
    return !KNOWN_SOAT_ACTIONS.has(action);
  });
  if (unknown.length === 0) return;
  const details = unknown
    .map((action) => {
      const suggestion = camelToKebab(action);
      return KNOWN_SOAT_ACTIONS.has(suggestion)
        ? `"${action}" (did you mean "${suggestion}"?)`
        : `"${action}"`;
    })
    .join(', ');
  throw new DomainError(
    'VALIDATION_FAILED',
    `Unknown SOAT action(s): ${details}.`
  );
};

// ── Mapped Types ─────────────────────────────────────────────────────────

export type MappedTool = {
  id: string;
  projectId: string;
  type: string;
  name: string;
  description: string | null;
  parameters: object | null;
  execute: object | null;
  mcp: object | null;
  actions: string[] | null;
  deniedActions: string[] | null;
  presetParameters: object | null;
  pipeline: object | null;
  discussionId: string | null;
  outputMapping: object | null;
  guardrailIds: string[] | null;
  createdAt: Date;
  updatedAt: Date;
};

// ── Map Helpers ───────────────────────────────────────────────────────────

const getToolIncludes = () => {
  return [{ model: db.Project, as: 'project' }];
};

const mapTool = (
  tool: InstanceType<typeof db.Tool> & {
    project: InstanceType<typeof db.Project>;
  }
): MappedTool => {
  return {
    id: tool.publicId,
    projectId: tool.project.publicId,
    type: tool.type,
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    execute: tool.execute,
    mcp: tool.mcp,
    actions: tool.actions,
    deniedActions: tool.deniedActions,
    presetParameters: tool.presetParameters,
    pipeline: tool.pipeline,
    discussionId:
      (tool.discussion as { discussionId?: string } | null)?.discussionId ??
      null,
    outputMapping: tool.outputMapping,
    guardrailIds: tool.guardrailIds,
    createdAt: tool.createdAt,
    updatedAt: tool.updatedAt,
  };
};

// ── CRUD ──────────────────────────────────────────────────────────────────

export type CreateToolArgs = InlineToolDefinition & {
  projectId: number;
  guardrailIds?: string[] | null;
};

const nullify = <T>(value: T | undefined): T | null => {
  return value ?? null;
};

const buildToolConfigFields = (args: CreateToolArgs) => {
  return {
    description: nullify(args.description),
    parameters: nullify(args.parameters),
    execute: nullify(args.execute),
    mcp: nullify(args.mcp),
    actions: nullify(args.actions),
    deniedActions: nullify(args.deniedActions),
    presetParameters: nullify(args.presetParameters),
    pipeline: nullify(args.pipeline),
    discussion: args.discussionId ? { discussionId: args.discussionId } : null,
    outputMapping: nullify(args.outputMapping),
    guardrailIds: nullify(args.guardrailIds),
  };
};

const buildToolCreateAttributes = (args: CreateToolArgs) => {
  return {
    projectId: args.projectId,
    type: args.type ?? 'http',
    name: args.name,
    ...buildToolConfigFields(args),
  };
};

// ── Shared Tool Definition Validation ────────────────────────────────────────

/**
 * Validates a tool definition's business rules — shared by `createTool` (a
 * persisted Tool row) and every ephemeral consumer (an agent's inline `tools`,
 * a pipeline step's inline `tool`): a name is required, `pipeline` steps
 * reference tools that exist, `soat` actions are known, and `{{secret:...}}`
 * references resolve within the given project.
 */
/**
 * Validates a `discussion` tool's config: it must reference a discussion that
 * exists in the tool's project (so a tool cannot invoke another project's
 * discussion).
 */
const assertDiscussionToolValid = async (args: {
  definition: InlineToolDefinition;
  projectId: number;
}): Promise<void> => {
  if (!args.definition.discussionId) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'A discussion tool requires a discussion_id.'
    );
  }
  const discussion = await db.Discussion.findOne({
    where: {
      publicId: args.definition.discussionId,
      projectId: args.projectId,
    },
  });
  if (!discussion) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Discussion '${args.definition.discussionId}' not found in the project.`
    );
  }
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

  if (definition.type === 'pipeline') {
    const config = validatePipelineConfig(definition.pipeline);
    await assertPipelineStepToolsValid({
      steps: config.steps,
      projectId,
      projectIds: [projectId],
    });
  }

  if ((definition.type ?? 'http') === 'soat') {
    validateSoatActions(definition.actions);
  }

  if (definition.type === 'discussion') {
    await assertDiscussionToolValid({ definition, projectId });
  }

  // Reject any {{...}} token that isn't a {{secret:...}} reference before
  // checking whether referenced secrets actually exist.
  assertNoInvalidTemplateTokens({
    execute: definition.execute,
    mcp: definition.mcp,
  });

  // Fail fast on {{secret:...}} tokens referencing nonexistent or
  // out-of-project secrets, instead of failing at first call.
  await assertSecretRefsExist({
    value: { execute: definition.execute, mcp: definition.mcp },
    projectId,
  });
};

export const createTool = async (args: CreateToolArgs): Promise<MappedTool> => {
  await validateToolDefinition({ definition: args, projectId: args.projectId });
  await assertGuardrailsExist({
    guardrailIds: args.guardrailIds,
    projectId: args.projectId,
  });

  const tool = await db.Tool.create(buildToolCreateAttributes(args));

  const created = await db.Tool.findOne({
    where: { id: (tool as unknown as { id: number }).id },
    include: getToolIncludes(),
  });

  return mapTool(created as unknown as Parameters<typeof mapTool>[0]);
};

export const listTools = async (args: {
  projectIds?: number[];
}): Promise<MappedTool[]> => {
  const where: Record<string, unknown> = {};
  if (args.projectIds !== undefined) {
    where.projectId = args.projectIds;
  }

  const tools = await db.Tool.findAll({
    where,
    include: getToolIncludes(),
    order: [['createdAt', 'DESC']],
  });

  return tools.map((t) => {
    return mapTool(t as unknown as Parameters<typeof mapTool>[0]);
  });
};

const findToolInstance = async (args: {
  projectIds?: number[];
  id: string;
}) => {
  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds !== undefined) {
    where.projectId = args.projectIds;
  }

  const tool = await db.Tool.findOne({
    where,
    include: getToolIncludes(),
  });

  if (!tool)
    throw new DomainError('RESOURCE_NOT_FOUND', `Tool '${args.id}' not found.`);

  return tool;
};

export const getTool = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<MappedTool> => {
  const tool = await findToolInstance(args);
  return mapTool(tool as unknown as Parameters<typeof mapTool>[0]);
};

const buildToolUpdates = (args: {
  type?: string;
  name?: string;
  description?: string | null;
  parameters?: object | null;
  execute?: object | null;
  mcp?: object | null;
  actions?: string[] | null;
  deniedActions?: string[] | null;
  presetParameters?: object | null;
  pipeline?: object | null;
  discussionId?: string | null;
  outputMapping?: object | null;
  guardrailIds?: string[] | null;
}): Record<string, unknown> => {
  const updates: Record<string, unknown> = {};
  const scalarFields = [
    'type',
    'name',
    'description',
    'parameters',
    'execute',
    'mcp',
    'actions',
    'deniedActions',
    'presetParameters',
    'pipeline',
    'outputMapping',
    'guardrailIds',
  ] as const;
  for (const field of scalarFields) {
    if (args[field] !== undefined) updates[field] = args[field];
  }
  if (args.discussionId !== undefined) {
    updates.discussion = args.discussionId
      ? { discussionId: args.discussionId }
      : null;
  }
  return updates;
};

type ToolUpdateArgs = {
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
  presetParameters?: object | null;
  pipeline?: object | null;
  discussionId?: string | null;
  outputMapping?: object | null;
  guardrailIds?: string[] | null;
};

/** Runs the per-type validation for an update against the existing tool row. */
const validateToolUpdate = async (params: {
  args: ToolUpdateArgs;
  tool: InstanceType<typeof db.Tool>;
}): Promise<void> => {
  const { args, tool } = params;
  if (args.discussionId !== undefined && args.discussionId !== null) {
    await assertDiscussionToolValid({
      definition: {
        name: tool.name,
        type: 'discussion',
        discussionId: args.discussionId,
      },
      projectId: tool.projectId,
    });
  }
  if (args.pipeline !== undefined && args.pipeline !== null) {
    const config = validatePipelineConfig(args.pipeline);
    await assertPipelineStepToolsValid({
      steps: config.steps,
      projectId: tool.projectId,
      projectIds: args.projectIds,
    });
  }
  if (args.actions !== undefined && (args.type ?? tool.type) === 'soat') {
    validateSoatActions(args.actions);
  }
  if (args.execute !== undefined || args.mcp !== undefined) {
    assertNoInvalidTemplateTokens({ execute: args.execute, mcp: args.mcp });
    await assertSecretRefsExist({
      value: { execute: args.execute, mcp: args.mcp },
      projectId: tool.projectId,
    });
  }
};

export const updateTool = async (args: ToolUpdateArgs): Promise<MappedTool> => {
  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds !== undefined) {
    where.projectId = args.projectIds;
  }

  const tool = await db.Tool.findOne({ where });

  if (!tool)
    throw new DomainError('RESOURCE_NOT_FOUND', `Tool '${args.id}' not found.`);

  await validateToolUpdate({ args, tool });
  await assertGuardrailsExist({
    guardrailIds: args.guardrailIds,
    projectId: tool.projectId,
  });

  await tool.update(buildToolUpdates(args));

  const updated = await db.Tool.findOne({
    where: { id: (tool as unknown as { id: number }).id },
    include: getToolIncludes(),
  });

  return mapTool(updated as unknown as Parameters<typeof mapTool>[0]);
};

export const deleteTool = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<void> => {
  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds !== undefined) {
    where.projectId = args.projectIds;
  }

  const tool = await db.Tool.findOne({ where });

  if (!tool)
    throw new DomainError('RESOURCE_NOT_FOUND', `Tool '${args.id}' not found.`);

  await tool.destroy();
};

// ── Call ──────────────────────────────────────────────────────────────────

// A thin DB-backed wrapper around `callResolvedTool` (toolsCall.ts), which
// holds the actual per-type dispatch logic shared with `callEphemeralTool`.
export const callTool = async (args: {
  projectIds?: number[];
  id: string;
  action?: string;
  input?: Record<string, unknown>;
  authHeader?: string;
  remainingDepth?: number;
}): Promise<unknown> => {
  const toolInstance = await findToolInstance({
    projectIds: args.projectIds,
    id: args.id,
  });
  const foundTool = mapTool(
    toolInstance as unknown as Parameters<typeof mapTool>[0]
  );

  return callResolvedTool({
    tool: foundTool,
    toolProjectId: toolInstance.projectId,
    action: args.action,
    input: args.input,
    authHeader: args.authHeader,
    remainingDepth: args.remainingDepth,
    projectIds: args.projectIds,
  });
};
