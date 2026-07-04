import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { applyToolOutputMapping } from './jsonLogicMapping';
import {
  assertPipelineStepToolsValid,
  runPipeline,
  validatePipelineConfig,
} from './pipelineTools';
import { assertSecretRefsExist } from './secrets';
import { soatTools } from './soatTools';
import { callHttpTool, callMcpTool, callSoatTool } from './toolsCall';

const log = createDebug('soat:tools');

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
  presetParameters: object | null;
  pipeline: object | null;
  outputMapping: object | null;
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
    presetParameters: tool.presetParameters,
    pipeline: tool.pipeline,
    outputMapping: tool.outputMapping,
    createdAt: tool.createdAt,
    updatedAt: tool.updatedAt,
  };
};

// ── CRUD ──────────────────────────────────────────────────────────────────

export type CreateToolArgs = {
  projectId: number;
  type?: string;
  name: string;
  description?: string;
  parameters?: object;
  execute?: object;
  mcp?: object;
  actions?: string[];
  presetParameters?: object;
  pipeline?: object;
  outputMapping?: object;
};

const buildToolCreateAttributes = (args: CreateToolArgs) => {
  return {
    projectId: args.projectId,
    type: args.type ?? 'http',
    name: args.name,
    description: args.description ?? null,
    parameters: args.parameters ?? null,
    execute: args.execute ?? null,
    mcp: args.mcp ?? null,
    actions: args.actions ?? null,
    presetParameters: args.presetParameters ?? null,
    pipeline: args.pipeline ?? null,
    outputMapping: args.outputMapping ?? null,
  };
};

export const createTool = async (args: CreateToolArgs): Promise<MappedTool> => {
  if (args.type === 'pipeline') {
    const config = validatePipelineConfig(args.pipeline);
    await assertPipelineStepToolsValid({
      steps: config.steps,
      projectIds: [args.projectId],
    });
  }

  if ((args.type ?? 'http') === 'soat') {
    validateSoatActions(args.actions);
  }

  // Fail fast on {{secret:...}} tokens referencing nonexistent or
  // out-of-project secrets, instead of failing at first call.
  await assertSecretRefsExist({
    value: { execute: args.execute, mcp: args.mcp },
    projectId: args.projectId,
  });

  const tool = await db.Tool.create(buildToolCreateAttributes(args));

  const created = await db.Tool.findOne({
    where: { id: (tool as unknown as { id: number }).id },
    include: getToolIncludes(),
  });

  return mapTool(created as unknown as Parameters<typeof mapTool>[0]);
};

// ── Inline Tool Definitions ─────────────────────────────────────────────────

// An inline tool definition mirrors `createTool`'s args minus `projectId`,
// which is always the owning resource's own project (e.g. the agent's).
export type InlineToolDefinition = Omit<CreateToolArgs, 'projectId'>;

/**
 * Persists each inline tool definition as a standalone Tool resource (so it
 * shows up in list-tools, permissions, and the MCP surface like any other
 * tool) and returns the resulting public IDs. Used by callers (e.g. agents)
 * that accept inline tool definitions instead of only pre-created tool IDs.
 */
export const createInlineTools = async (args: {
  projectId: number;
  tools: InlineToolDefinition[];
}): Promise<string[]> => {
  const ids: string[] = [];
  for (const toolDef of args.tools) {
    if (!toolDef.name || typeof toolDef.name !== 'string') {
      throw new DomainError(
        'VALIDATION_FAILED',
        'Inline tool definitions require a name.'
      );
    }
    log(
      'createInlineTools: projectId=%d name=%s',
      args.projectId,
      toolDef.name
    );
    const created = await createTool({ projectId: args.projectId, ...toolDef });
    ids.push(created.id);
  }
  return ids;
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
  presetParameters?: object | null;
  pipeline?: object | null;
  outputMapping?: object | null;
}): Record<string, unknown> => {
  const updates: Record<string, unknown> = {};
  const fields = [
    'type',
    'name',
    'description',
    'parameters',
    'execute',
    'mcp',
    'actions',
    'presetParameters',
    'pipeline',
    'outputMapping',
  ] as const;
  for (const field of fields) {
    if (args[field] !== undefined) updates[field] = args[field];
  }
  return updates;
};

export const updateTool = async (args: {
  projectIds?: number[];
  id: string;
  type?: string;
  name?: string;
  description?: string | null;
  parameters?: object | null;
  execute?: object | null;
  mcp?: object | null;
  actions?: string[] | null;
  presetParameters?: object | null;
  pipeline?: object | null;
  outputMapping?: object | null;
}): Promise<MappedTool> => {
  if (args.pipeline !== undefined && args.pipeline !== null) {
    const config = validatePipelineConfig(args.pipeline);
    await assertPipelineStepToolsValid({
      steps: config.steps,
      projectIds: args.projectIds,
    });
  }

  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds !== undefined) {
    where.projectId = args.projectIds;
  }

  const tool = await db.Tool.findOne({ where });

  if (!tool)
    throw new DomainError('RESOURCE_NOT_FOUND', `Tool '${args.id}' not found.`);

  if (args.actions !== undefined && (args.type ?? tool.type) === 'soat') {
    validateSoatActions(args.actions);
  }

  if (args.execute !== undefined || args.mcp !== undefined) {
    await assertSecretRefsExist({
      value: { execute: args.execute, mcp: args.mcp },
      projectId: tool.projectId,
    });
  }

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
  const toolProjectId = toolInstance.projectId;

  if (foundTool.type === 'pipeline') {
    const rawResult = await runPipeline({
      pipeline: foundTool.pipeline,
      presetParameters: foundTool.presetParameters,
      input: args.input,
      remainingDepth: args.remainingDepth,
      callStep: (step) => {
        return callTool({
          projectIds: args.projectIds,
          id: step.toolId,
          action: step.action,
          input: step.input,
          authHeader: args.authHeader,
          remainingDepth: step.remainingDepth,
        });
      },
    });
    return applyToolOutputMapping(
      foundTool.outputMapping as Record<string, unknown> | null,
      rawResult
    );
  }

  const mergedInput = {
    ...(foundTool.presetParameters ?? {}),
    ...(args.input ?? {}),
  };

  let rawResult: unknown;
  if (foundTool.type === 'http') {
    rawResult = await callHttpTool(foundTool, mergedInput, toolProjectId);
  } else if (foundTool.type === 'soat') {
    rawResult = await callSoatTool(foundTool, {
      action: args.action,
      mergedInput,
      authHeader: args.authHeader,
    });
  } else if (foundTool.type === 'mcp') {
    rawResult = await callMcpTool(
      foundTool,
      args.action,
      mergedInput,
      toolProjectId
    );
  } else {
    // client tools (and any unknown type) cannot be invoked server-side
    throw new DomainError(
      'TOOL_CALL_NOT_SUPPORTED',
      'Client tools cannot be invoked server-side; they must be executed by the calling client.'
    );
  }

  return applyToolOutputMapping(
    foundTool.outputMapping as Record<string, unknown> | null,
    rawResult
  );
};
