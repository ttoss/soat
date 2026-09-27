import { db } from '../db';
import { DomainError } from '../errors';
import { readKnowledgeConfig } from './agentKnowledge';
import { readAgentToolBindings, splitToolBindings } from './agentToolBindings';
import { narrowToActiveTools } from './agentToolSelection';

export type DeciderAgentRow = InstanceType<(typeof db)['Agent']>;

/**
 * The tools a generation of this agent would be offered, read from the same
 * two sources `resolveAgentToolSurface` builds the surface from: the bindings
 * `active_tool_ids` leaves active, and the `write_memory` tool a write store
 * adds.
 */
const toolSurfaceOf = (agent: DeciderAgentRow): string[] => {
  const bound = splitToolBindings(readAgentToolBindings(agent));
  const surface = [
    ...narrowToActiveTools({
      toolIds: bound.toolIds,
      activeToolIds: agent.activeToolIds,
    }),
    ...bound.tools.map((tool) => {
      return tool.name;
    }),
  ];
  if (readKnowledgeConfig(agent.knowledgeConfig)?.writeMemoryStoreId) {
    surface.push('write_memory');
  }
  return surface;
};

/**
 * Refuses an agent that could call a tool. A tool call is the only thing that
 * parks a generation, and a decision has no route to resume one; nor may
 * evaluating a state take a side effect the decision cannot record.
 */
export const assertDeciderAgentToolLess = (agent: DeciderAgentRow): void => {
  const surface = toolSurfaceOf(agent);
  if (surface.length === 0) return;
  throw new DomainError(
    'DECIDER_AGENT_NOT_TOOL_LESS',
    `Agent '${agent.publicId}' has a tool surface (${surface.join(', ')}); a decider's agent must have none.`,
    { agent_id: agent.publicId, tools: surface }
  );
};

/** The agent a decider names, in the decider's own project. */
export const findDeciderAgent = async (args: {
  projectId: number;
  agentPublicId: unknown;
}): Promise<DeciderAgentRow> => {
  if (typeof args.agentPublicId !== 'string' || args.agentPublicId === '') {
    throw new DomainError('VALIDATION_FAILED', 'agent_id is required.');
  }
  const agent = await db.Agent.findOne({
    where: { publicId: args.agentPublicId, projectId: args.projectId },
  });
  if (!agent) {
    throw new DomainError(
      'AGENT_NOT_FOUND',
      `Agent '${args.agentPublicId}' not found in this project.`
    );
  }
  return agent;
};
