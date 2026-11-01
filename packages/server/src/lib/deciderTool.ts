import createDebug from 'debug';

import type { db } from '../db';
import { DomainError } from '../errors';
import type { DeciderQuestions, DecisionAnswer } from './deciderQuestions';
import { DECIDER_USAGE_SOURCE } from './deciderQuestions';
import { parseToolAnswers } from './deciderToolAnswer';
import { isPlainObject } from './plainObject';
import { toolReferences } from './resourceReferences';
import { callTool } from './tools';
import { serverSideToolProblem } from './toolsCallDispatch';

const log = createDebug('soat:deciders');

export type DeciderToolRow = InstanceType<(typeof db)['Tool']>;

const DECIDER_TOOL_PROBLEMS = {
  runs_on_client: 'has no caller to hand the call to',
  action_required:
    "needs an action a decider does not carry: name it in a builtin tool's preset_parameters or in a pipeline step",
} as const;

/** The call input keys a decider owns; presets are merged over the input. */
const DECIDER_INPUT_KEYS = ['input', 'questions'];

/**
 * Refuses a tool that cannot answer a decision. Run at the decider write and
 * again at admission, since the tool stays editable after a decider names it.
 */
export const assertDeciderToolCallable = (tool: DeciderToolRow): void => {
  const problem = serverSideToolProblem({
    tool,
    action: null,
    // `{ input, questions }`, which names no action.
    input: null,
  });
  if (problem) {
    throw new DomainError(
      'DECIDER_TOOL_NOT_CALLABLE',
      `Tool '${tool.publicId}' is a ${tool.type} tool, which ${DECIDER_TOOL_PROBLEMS[problem]}.`,
      { tool_id: tool.publicId, type: tool.type }
    );
  }
  const presets = isPlainObject(tool.presetParameters)
    ? tool.presetParameters
    : {};
  const pinned = DECIDER_INPUT_KEYS.filter((key) => {
    return key in presets;
  });
  if (pinned.length === 0) return;
  throw new DomainError(
    'DECIDER_TOOL_NOT_CALLABLE',
    `Tool '${tool.publicId}' pins ${pinned.join(' and ')} in its preset_parameters, which would replace what the decider sends.`,
    { tool_id: tool.publicId, pinned }
  );
};

/** The tool a decider names, in the decider's own project. */
export const findDeciderTool = async (args: {
  projectId: number;
  toolPublicId: unknown;
}): Promise<DeciderToolRow> => {
  if (typeof args.toolPublicId !== 'string' || args.toolPublicId === '') {
    throw new DomainError('VALIDATION_FAILED', 'tool_id must be a string.');
  }
  const tool = await toolReferences.find({
    id: args.toolPublicId,
    projectId: args.projectId,
    reach: 'project',
  });
  if (!tool) {
    throw new DomainError(
      'TOOL_NOT_FOUND',
      `Tool '${args.toolPublicId}' not found in this project.`
    );
  }
  return tool;
};

/**
 * Asks the tool and reads its answer against the contract. Through `callTool`,
 * so the call is metered, egress-checked and guarded like any other. The tool
 * receives `{ input, questions }`, the request body of OpenAI's Decisions API
 * less `model`, which a preset can supply.
 */
export const answerWithTool = async (args: {
  projectId: number;
  toolPublicId: string;
  questions: DeciderQuestions;
  input: unknown;
  /**
   * The requester's credential: a `builtin` step calls this server's API as
   * whoever asked for the decision, never as nobody or as anyone else.
   */
  authHeader?: string;
}): Promise<DecisionAnswer[]> => {
  log('answerWithTool: toolId=%s', args.toolPublicId);
  const raw = await callTool({
    projectId: args.projectId,
    reach: 'project',
    id: args.toolPublicId,
    guardrails: 'apply',
    input: { input: args.input, questions: args.questions },
    authHeader: args.authHeader,
    attribution: { source: DECIDER_USAGE_SOURCE },
  });
  return parseToolAnswers({ questions: args.questions, raw });
};
