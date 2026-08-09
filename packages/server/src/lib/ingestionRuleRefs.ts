import { db } from '../db';
import { DomainError } from '../errors';
// This module keeps its own `TOOL_NOT_FOUND` / `AGENT_NOT_FOUND` throws — a
// *referenced-entity* miss on a request field is a `400`, not the `404` a
// top-level lookup returns — so it borrows the scope rule alone. That is the
// half that must not drift: how a credential scope narrows a lookup is one
// rule, with one implementation.
import { scopedWhere } from './resourceAccessor';

/**
 * Resolves the public tool/agent ids from a REST request to the internal
 * numeric ids the CRUD functions expect, scoped to the caller's projects.
 * `undefined` is preserved (field omitted — keep existing on update); `null` is
 * preserved (explicit clear). Throws `TOOL_NOT_FOUND` / `AGENT_NOT_FOUND` when a
 * provided public id has no row in scope. Keeps DB access in the lib layer.
 */
export const resolveConverterRefs = async (args: {
  // `undefined` means unrestricted (admin) — matches the `!== undefined`
  // scoping convention used throughout ingestionRules.ts, and avoids ever
  // putting a literal `undefined` into a Sequelize `where` clause.
  projectIds?: number[];
  toolId?: string | null;
  agentId?: string | null;
}): Promise<{ toolId?: number | null; agentId?: number | null }> => {
  const result: { toolId?: number | null; agentId?: number | null } = {};

  if (args.toolId !== undefined) {
    if (args.toolId === null) {
      result.toolId = null;
    } else {
      const tool = await db.Tool.findOne({
        where: scopedWhere({
          id: args.toolId,
          projectIds: args.projectIds,
        }),
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
        where: scopedWhere({
          id: args.agentId,
          projectIds: args.projectIds,
        }),
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

/**
 * Looks up the converter's tool type (needed by `validateIngestionRule`) and
 * confirms the referenced tool/agent exists in the project.
 */
export const resolveConverterToolType = async (args: {
  projectId: number;
  toolId?: number | null;
  agentId?: number | null;
}): Promise<string | null> => {
  if (args.toolId) {
    const tool = await db.Tool.findOne({
      where: { id: args.toolId, projectId: args.projectId },
    });
    if (!tool) {
      throw new DomainError(
        'TOOL_NOT_FOUND',
        `Tool '${args.toolId}' not found in this project.`
      );
    }
    return tool.type;
  }
  if (args.agentId) {
    const agent = await db.Agent.findOne({
      where: { id: args.agentId, projectId: args.projectId },
    });
    if (!agent) {
      throw new DomainError(
        'AGENT_NOT_FOUND',
        `Agent '${args.agentId}' not found in this project.`
      );
    }
  }
  return null;
};
