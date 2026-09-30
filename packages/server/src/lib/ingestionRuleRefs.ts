import { db } from '../db';
import { DomainError } from '../errors';
import { agentReferences, toolReferences } from './resourceReferences';

/**
 * Resolves the public tool/agent ids from a REST request to the internal
 * numeric ids the CRUD functions expect, in the rule's project. `undefined` is
 * preserved (field omitted — keep existing on update); `null` is preserved
 * (explicit clear). Throws `TOOL_NOT_FOUND` / `AGENT_NOT_FOUND` when a provided
 * public id has no row in that project.
 */
export const resolveConverterRefs = async (args: {
  projectId: number;
  toolId?: string | null;
  agentId?: string | null;
}): Promise<{ toolId?: number | null; agentId?: number | null }> => {
  const result: { toolId?: number | null; agentId?: number | null } = {};

  if (args.toolId !== undefined) {
    if (args.toolId === null) {
      result.toolId = null;
    } else {
      const tool = await toolReferences.find({
        id: args.toolId,
        projectId: args.projectId,
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
      const agent = await agentReferences.find({
        id: args.agentId,
        projectId: args.projectId,
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
