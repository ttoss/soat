import { agentReferences, toolReferences } from './resourceReferences';

/** The node fields that name another resource; structural, so this module needs no graph types. */
type ReferencingNode = {
  type: string;
  toolId?: string | null;
  agentId?: string | null;
};

const TOOL_REFERENCING_TYPES = new Set(['tool', 'poll', 'approval']);

/**
 * Refuses a node naming a tool or agent outside `projectId`, the
 * orchestration's own project, where every run of it resolves them.
 */
export const assertNodeReferencesInProject = async (args: {
  nodes: ReferencingNode[];
  projectId: number;
}): Promise<void> => {
  const toolIds = args.nodes.flatMap((node) => {
    return TOOL_REFERENCING_TYPES.has(node.type) && node.toolId
      ? [node.toolId]
      : [];
  });
  const agentIds = args.nodes.flatMap((node) => {
    return node.type === 'agent' && node.agentId ? [node.agentId] : [];
  });
  await toolReferences.requireMany({
    ids: toolIds,
    projectId: args.projectId,
    reach: 'shares',
  });
  await agentReferences.requireMany({
    ids: agentIds,
    projectId: args.projectId,
    reach: 'shares',
  });
};
