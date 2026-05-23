import { db } from '../db';
import { DomainError } from '../errors';

// ── Mapped Types ─────────────────────────────────────────────────────────

export type MappedAgentTool = {
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

const getAgentToolIncludes = () => {
  return [{ model: db.Project, as: 'project' }];
};

const mapAgentTool = (
  tool: InstanceType<typeof db.AgentTool> & {
    project: InstanceType<typeof db.Project>;
  }
): MappedAgentTool => {
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

export const createAgentTool = async (args: {
  projectId: number;
  type?: string;
  name: string;
  description?: string;
  parameters?: object;
  execute?: object;
  mcp?: object;
  actions?: string[];
  presetParameters?: object;
}): Promise<MappedAgentTool> => {
  const agentTool = await db.AgentTool.create({
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

  const created = await db.AgentTool.findOne({
    where: { id: (agentTool as unknown as { id: number }).id },
    include: getAgentToolIncludes(),
  });

  return mapAgentTool(created as unknown as Parameters<typeof mapAgentTool>[0]);
};

export const listAgentTools = async (args: {
  projectIds?: number[];
}): Promise<MappedAgentTool[]> => {
  const where: Record<string, unknown> = {};
  if (args.projectIds !== undefined) {
    where.projectId = args.projectIds;
  }

  const tools = await db.AgentTool.findAll({
    where,
    include: getAgentToolIncludes(),
    order: [['createdAt', 'DESC']],
  });

  return tools.map((t) => {
    return mapAgentTool(t as unknown as Parameters<typeof mapAgentTool>[0]);
  });
};

export const getAgentTool = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<MappedAgentTool> => {
  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds !== undefined) {
    where.projectId = args.projectIds;
  }

  const agentTool = await db.AgentTool.findOne({
    where,
    include: getAgentToolIncludes(),
  });

  if (!agentTool)
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Agent tool '${args.id}' not found.`
    );

  return mapAgentTool(
    agentTool as unknown as Parameters<typeof mapAgentTool>[0]
  );
};

const buildAgentToolUpdates = (args: {
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

export const updateAgentTool = async (args: {
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
}): Promise<MappedAgentTool> => {
  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds !== undefined) {
    where.projectId = args.projectIds;
  }

  const agentTool = await db.AgentTool.findOne({ where });

  if (!agentTool)
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Agent tool '${args.id}' not found.`
    );

  await agentTool.update(buildAgentToolUpdates(args));

  const updated = await db.AgentTool.findOne({
    where: { id: (agentTool as unknown as { id: number }).id },
    include: getAgentToolIncludes(),
  });

  return mapAgentTool(updated as unknown as Parameters<typeof mapAgentTool>[0]);
};

export const deleteAgentTool = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<void> => {
  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds !== undefined) {
    where.projectId = args.projectIds;
  }

  const agentTool = await db.AgentTool.findOne({ where });

  if (!agentTool)
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Agent tool '${args.id}' not found.`
    );

  await agentTool.destroy();
};
