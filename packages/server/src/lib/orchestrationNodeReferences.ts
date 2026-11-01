import { agentReferences, toolReferences } from './resourceReferences';
import { serverSideToolValidationProblem } from './serverSideToolValidation';
import type { ValidationProblem } from './validationProblems';
import { throwValidationProblems } from './validationProblems';

/** The node fields that name another resource; structural, so this module needs no graph types. */
type ReferencingNode = {
  type: string;
  toolId?: string | null;
  agentId?: string | null;
  operationId?: string | null;
};

const TOOL_REFERENCING_TYPES = new Set(['tool', 'poll', 'approval']);

/** The nodes whose run calls their tool; an `approval` node only proposes it. */
const TOOL_CALLING_TYPES = new Set(['tool', 'poll']);

/**
 * Refuses a node naming a tool or agent outside `projectId`, the
 * orchestration's own project, where every run of it resolves them, and a
 * node calling a tool no server-side caller can run.
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
  const tools = await toolReferences.requireMany({
    ids: toolIds,
    projectId: args.projectId,
    reach: 'shares',
  });
  await agentReferences.requireMany({
    ids: agentIds,
    projectId: args.projectId,
    reach: 'shares',
  });

  const problems = args.nodes.flatMap((node, index): ValidationProblem[] => {
    const tool = node.toolId ? tools.get(node.toolId) : undefined;
    if (!tool || !TOOL_CALLING_TYPES.has(node.type)) return [];
    const problem = serverSideToolValidationProblem({
      tool,
      action: node.operationId,
      toolPath: `nodes[${index}].tool_id`,
      actionPath: `nodes[${index}].operation_id`,
    });
    return problem ? [problem] : [];
  });
  if (problems.length === 0) return;
  throwValidationProblems({
    code: 'ORCHESTRATION_VALIDATION_FAILED',
    subject: 'Orchestration',
    problems,
    warnings: [],
  });
};
