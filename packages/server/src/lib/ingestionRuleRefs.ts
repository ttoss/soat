import { db } from '../db';
import { DomainError } from '../errors';

/**
 * Resolves the public tool/agent ids from a REST request to the internal
 * numeric ids the CRUD functions expect, scoped to the caller's projects.
 * `undefined` is preserved (field omitted — keep existing on update); `null` is
 * preserved (explicit clear). Throws `TOOL_NOT_FOUND` / `AGENT_NOT_FOUND` when a
 * provided public id has no row in scope. Keeps DB access in the lib layer.
 */
export const resolveConverterRefs = async (args: {
  projectIds: number[];
  toolId?: string | null;
  agentId?: string | null;
}): Promise<{ toolId?: number | null; agentId?: number | null }> => {
  const result: { toolId?: number | null; agentId?: number | null } = {};

  if (args.toolId !== undefined) {
    if (args.toolId === null) {
      result.toolId = null;
    } else {
      const tool = await db.Tool.findOne({
        where: { publicId: args.toolId, projectId: args.projectIds },
      });
      if (!tool) {
        throw new DomainError(
          'TOOL_NOT_FOUND',
          `Tool '${args.toolId}' not found in this project.`
        );
      }
      result.toolId = tool.id as number;
    }
  }

  if (args.agentId !== undefined) {
    if (args.agentId === null) {
      result.agentId = null;
    } else {
      const agent = await db.Agent.findOne({
        where: { publicId: args.agentId, projectId: args.projectIds },
      });
      if (!agent) {
        throw new DomainError(
          'AGENT_NOT_FOUND',
          `Agent '${args.agentId}' not found in this project.`
        );
      }
      result.agentId = agent.id as number;
    }
  }

  return result;
};
