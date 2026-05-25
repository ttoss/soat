import { db } from '../db';
import { DomainError } from '../errors';
import {
  buildHttpToolExecute,
  parseHttpExecuteConfig,
} from './agentToolResolver';
import {
  buildMcpToolExecute,
  executeSoatTool,
} from './agentToolResolverExternalTools';
import { soatTools } from './soatTools';

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
    createdAt: tool.createdAt,
    updatedAt: tool.updatedAt,
  };
};

// ── CRUD ──────────────────────────────────────────────────────────────────

export const createTool = async (args: {
  projectId: number;
  type?: string;
  name: string;
  description?: string;
  parameters?: object;
  execute?: object;
  mcp?: object;
  actions?: string[];
  presetParameters?: object;
}): Promise<MappedTool> => {
  const tool = await db.Tool.create({
    projectId: args.projectId,
    type: args.type ?? 'http',
    name: args.name,
    description: args.description ?? null,
    parameters: args.parameters ?? null,
    execute: args.execute ?? null,
    mcp: args.mcp ?? null,
    actions: args.actions ?? null,
    presetParameters: args.presetParameters ?? null,
  });

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

export const getTool = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<MappedTool> => {
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
}): Promise<MappedTool> => {
  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds !== undefined) {
    where.projectId = args.projectIds;
  }

  const tool = await db.Tool.findOne({ where });

  if (!tool)
    throw new DomainError('RESOURCE_NOT_FOUND', `Tool '${args.id}' not found.`);

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

const noopLogToolCallingError = () => {};

export const callTool = async (args: {
  projectIds?: number[];
  id: string;
  action?: string;
  input?: Record<string, unknown>;
  authHeader?: string;
}): Promise<unknown> => {
  const foundTool = await getTool({ projectIds: args.projectIds, id: args.id });
  const input = args.input ?? {};
  const mergedInput = { ...(foundTool.presetParameters ?? {}), ...input };

  if (foundTool.type === 'http') {
    const executeConfig = parseHttpExecuteConfig(
      (foundTool.execute as
        | { url: string; method?: string; headers?: Record<string, string> }
        | string
        | null) ?? null
    );
    if (!executeConfig) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'HTTP tool has an invalid execute configuration.'
      );
    }
    const execute = buildHttpToolExecute({
      toolName: foundTool.name,
      execute: executeConfig,
    });
    return execute(mergedInput);
  }

  if (foundTool.type === 'soat') {
    if (!args.action) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'action is required for soat tools.'
      );
    }
    if (!foundTool.actions?.includes(args.action)) {
      throw new DomainError(
        'VALIDATION_FAILED',
        `action "${args.action}" is not available on this tool.`
      );
    }
    const def = soatTools.find((t) => {
      return t.name === args.action;
    });
    if (!def) {
      throw new DomainError(
        'VALIDATION_FAILED',
        `action "${args.action}" is not a known SOAT action.`
      );
    }
    return executeSoatTool({
      toolName: foundTool.name,
      def,
      rawArgs: mergedInput,
      base: `http://localhost:${process.env.PORT ?? 5047}`,
      authHeader: args.authHeader,
      buildContextHeaders: () => {
        return {};
      },
      logToolCallingError: noopLogToolCallingError,
    });
  }

  if (foundTool.type === 'mcp') {
    if (!args.action) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'action is required for mcp tools.'
      );
    }
    const mcpConfig = foundTool.mcp as {
      url: string;
      headers?: Record<string, string>;
    } | null;
    if (!mcpConfig?.url) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'MCP tool has an invalid mcp configuration.'
      );
    }
    const execute = buildMcpToolExecute({
      mcpUrl: mcpConfig.url,
      mcpHeaders: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(mcpConfig.headers ?? {}),
      },
      mcpToolName: args.action,
      logToolCallingError: noopLogToolCallingError,
    });
    return execute(mergedInput);
  }

  // client tools (and any unknown type) cannot be invoked server-side
  throw new DomainError(
    'TOOL_CALL_NOT_SUPPORTED',
    'Client tools cannot be invoked server-side; they must be executed by the calling client.'
  );
};
