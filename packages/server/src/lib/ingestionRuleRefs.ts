import { db } from '../db';
import { DomainError } from '../errors';
import type { ConverterTool } from './ingestionRuleValidation';
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
        reach: 'shares',
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
        reach: 'shares',
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
 * Looks up the converter's tool (needed by `validateIngestionRule`) and
 * confirms the referenced tool/agent still exists.
 */
export const resolveConverterTool = async (args: {
  toolId?: number | null;
  agentId?: number | null;
}): Promise<ConverterTool | null> => {
  // The internal ids arrive already resolved in the rule's reach — its own
  // project or an accepted share — so only their existence is read here.
  if (args.toolId) {
    const tool = await db.Tool.findByPk(args.toolId, {
      attributes: ['type', 'presetParameters'],
    });
    if (!tool) {
      throw new DomainError(
        'TOOL_NOT_FOUND',
        `Tool '${args.toolId}' not found.`
      );
    }
    return {
      type: tool.type,
      presetParameters: (tool.presetParameters as object | null) ?? null,
    };
  }
  if (args.agentId) {
    const agent = await db.Agent.findByPk(args.agentId, {
      attributes: ['id'],
    });
    if (!agent) {
      throw new DomainError(
        'AGENT_NOT_FOUND',
        `Agent '${args.agentId}' not found.`
      );
    }
  }
  return null;
};
