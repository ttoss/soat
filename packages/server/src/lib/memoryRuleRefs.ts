import { db } from '../db';
import type { ErrorCode } from '../errors';
import { DomainError } from '../errors';

/**
 * Resolves the public ids a memory-rule request carries to the internal ids the
 * CRUD functions take, always inside one project.
 *
 * Keeps its own throws, like `ingestionRuleRefs.ts`: a referenced entity that is
 * missing is a `400` naming the field, not the `404` a top-level lookup returns.
 * `undefined` survives as `undefined` (field omitted — keep what is stored) and
 * `null` as `null` (an explicit clear).
 */
const resolveRef = async (args: {
  model: {
    findOne: (options: {
      where: { publicId: string; projectId: number };
    }) => Promise<{ id: number } | null>;
  };
  errorCode: ErrorCode;
  label: string;
  publicId?: string | null;
  projectId: number;
}): Promise<number | null | undefined> => {
  if (args.publicId === undefined) return undefined;
  if (args.publicId === null) return null;

  const row = await args.model.findOne({
    where: { publicId: args.publicId, projectId: args.projectId },
  });
  if (!row) {
    throw new DomainError(
      args.errorCode,
      `${args.label} '${args.publicId}' not found in this project.`
    );
  }
  return row.id;
};

export const resolveMemoryRuleRefs = async (args: {
  projectId: number;
  agentId?: string | null;
  toolId?: string | null;
  aiProviderId?: string | null;
}): Promise<{
  agentId?: number | null;
  toolId?: number | null;
  aiProviderId?: number | null;
}> => {
  const [agentId, toolId, aiProviderId] = await Promise.all([
    resolveRef({
      model: db.Agent,
      errorCode: 'AGENT_NOT_FOUND',
      label: 'Agent',
      publicId: args.agentId,
      projectId: args.projectId,
    }),
    resolveRef({
      model: db.Tool,
      errorCode: 'TOOL_NOT_FOUND',
      label: 'Tool',
      publicId: args.toolId,
      projectId: args.projectId,
    }),
    resolveRef({
      model: db.AiProvider,
      errorCode: 'AI_PROVIDER_NOT_FOUND',
      label: 'AI provider',
      publicId: args.aiProviderId,
      projectId: args.projectId,
    }),
  ]);

  return {
    ...(agentId === undefined ? {} : { agentId }),
    ...(toolId === undefined ? {} : { toolId }),
    ...(aiProviderId === undefined ? {} : { aiProviderId }),
  };
};

/**
 * Confirms every id in the selector names an agent in the project.
 *
 * The column stores public ids verbatim, so nothing else would ever catch a
 * typo: the rule would simply never match, which is the silent failure this
 * whole design exists to remove.
 */
export const assertSourceAgentIds = async (args: {
  projectId: number;
  sourceAgentIds?: string[] | null;
}): Promise<void> => {
  if (!args.sourceAgentIds?.length) return;

  const agents = await db.Agent.findAll({
    attributes: ['publicId'],
    where: { publicId: args.sourceAgentIds, projectId: args.projectId },
  });
  const found = new Set(
    agents.map((agent) => {
      return agent.publicId;
    })
  );
  const missing = args.sourceAgentIds.find((id) => {
    return !found.has(id);
  });
  if (missing) {
    throw new DomainError(
      'AGENT_NOT_FOUND',
      `Agent '${missing}' not found in this project.`
    );
  }
};
