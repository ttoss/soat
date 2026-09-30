import createDebug from 'debug';

import type { db } from '../db';
import { DomainError } from '../errors';
import type { DeciderQuestions, DecisionAnswer } from './deciderQuestions';
import { DECIDER_USAGE_SOURCE } from './deciderQuestions';
import { parseToolAnswers } from './deciderToolAnswer';
import { isPlainObject } from './plainObject';
import { toolReferences } from './resourceReferences';
import { callTool } from './tools';

const log = createDebug('soat:deciders');

export type DeciderToolRow = InstanceType<(typeof db)['Tool']>;

/**
 * `client` has no caller to hand the call to; `mcp` and `builtin` need an
 * `action`, which a decider does not carry — a `pipeline` step names one.
 */
const CALLABLE_TOOL_TYPES: ReadonlySet<string> = new Set(['http', 'pipeline']);

/** The call input keys a decider owns; presets are merged over the input. */
const DECIDER_INPUT_KEYS = ['state', 'questions'];

/**
 * Refuses a tool that cannot answer a decision. Run at the decider write and
 * again at admission, since the tool stays editable after a decider names it.
 */
export const assertDeciderToolCallable = (tool: DeciderToolRow): void => {
  if (!CALLABLE_TOOL_TYPES.has(tool.type)) {
    throw new DomainError(
      'DECIDER_TOOL_NOT_CALLABLE',
      `Tool '${tool.publicId}' is a ${tool.type} tool; a decider's tool must be http or pipeline.`,
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
 * so the call is metered, egress-checked and guarded like any other.
 */
export const answerWithTool = async (args: {
  projectId: number;
  toolPublicId: string;
  questions: DeciderQuestions;
  storedQuestions: object;
  state: unknown;
  /**
   * The requester's credential: a `builtin` step calls this server's API as
   * whoever asked for the decision, never as nobody or as anyone else.
   */
  authHeader?: string;
}): Promise<Record<string, DecisionAnswer>> => {
  log('answerWithTool: toolId=%s', args.toolPublicId);
  const raw = await callTool({
    projectIds: [args.projectId],
    id: args.toolPublicId,
    guardrails: 'apply',
    input: { state: args.state, questions: args.storedQuestions },
    authHeader: args.authHeader,
    attribution: { source: DECIDER_USAGE_SOURCE },
  });
  return parseToolAnswers({ questions: args.questions, raw });
};
