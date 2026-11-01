import { serverSideToolProblem } from './toolsCallDispatch';
import type { ValidationProblem } from './validationProblems';

/**
 * `serverSideToolProblem` as the problem a definition lists, for a tool whose
 * input is mapped at run time. `toolPath` and `actionPath` are wire paths.
 */
export const serverSideToolValidationProblem = (args: {
  tool: {
    publicId: string;
    type: string;
    presetParameters: object | null | undefined;
  };
  action: string | null | undefined;
  toolPath: string;
  actionPath: string;
}): ValidationProblem | null => {
  const { tool } = args;
  const problem = serverSideToolProblem({
    tool,
    action: args.action,
    input: 'open',
  });
  if (problem === 'runs_on_client') {
    return {
      code: 'TOOL_RUNS_ON_CLIENT',
      path: args.toolPath,
      message: `Tool '${tool.publicId}' is a client tool, which cannot run server-side.`,
    };
  }
  if (problem === 'action_required') {
    return {
      code: 'MISSING_FIELD',
      path: args.actionPath,
      message: `${tool.type} tool '${tool.publicId}' needs the action to call in '${args.actionPath.split('.').pop()}'.`,
    };
  }
  return null;
};
