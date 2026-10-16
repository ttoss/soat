import { DomainError } from '../errors';
import { createGeneration } from './agentGeneration';
import type { GenerationResult } from './agentGenerationTypes';
import {
  assertDeciderAgentToolLess,
  type DeciderAgentRow,
} from './deciderAgent';
import { renderDeciderFrame } from './deciderFrame';
import { parseDecisionInput } from './deciderInput';
import {
  compileAnswerSchema,
  DECIDER_USAGE_SOURCE,
  type DeciderQuestions,
  type DecisionAnswer,
  toDecisionAnswers,
} from './deciderQuestions';
import {
  answerWithTool,
  assertDeciderToolCallable,
  type DeciderToolRow,
} from './deciderTool';
import { isPlainObject } from './plainObject';
import { assertProjectAcceptsWork } from './projectPause';
import { quotaBreachError } from './quotaBreach';
import { checkGenerationQuota } from './quotaEnforcement';
import { type StoredError, toStoredError } from './storedError';

/**
 * The two backends a decision is answered by — a tool-less agent over the
 * frame, or a tool over `{ input, questions }` — and the admission each runs
 * before the decision is written, so a refusal is a `4xx`.
 */

export type DecisionOutcome =
  | {
      status: 'completed';
      answers: DecisionAnswer[];
      generationId: string | null;
    }
  | { status: 'failed'; error: StoredError };

const GENERATION_FAILURE: StoredError = {
  code: 'GENERATION_FAILED',
  message: 'The generation failed.',
};

const TOOL_FAILURE: StoredError = {
  code: 'INTERNAL_ERROR',
  message: 'The tool call failed.',
};

/** The backend's own error when it raised one; anything else is opaque. */
export const failedOutcome = (args: {
  error: unknown;
  opaque: StoredError;
}): DecisionOutcome => {
  return {
    status: 'failed',
    error: toStoredError({ ...args, label: 'decision' }),
  };
};

/* istanbul ignore next -- a non-streamed generation of a tool-less agent with
   an output schema always completes with an object or throws. */
const answerOf = (
  result: GenerationResult | ReadableStream
): Record<string, unknown> | null => {
  if (result instanceof ReadableStream) return null;
  const object = result.output?.object;
  return isPlainObject(object) ? object : null;
};

const outcomeOf = (args: {
  result: GenerationResult | ReadableStream;
  questions: DeciderQuestions;
}): DecisionOutcome => {
  const { result } = args;
  const answer = answerOf(result);
  /* istanbul ignore next -- see `answerOf`. */
  if (answer === null || result instanceof ReadableStream) {
    return { status: 'failed', error: GENERATION_FAILURE };
  }
  return {
    status: 'completed',
    answers: toDecisionAnswers({ questions: args.questions, answer }),
    generationId: result.id,
  };
};

/** Runs the agent over the frame; the generation carries the answer. */
const answerWithAgent = async (args: {
  projectIds?: number[];
  agentPublicId: string;
  agentVersion: number;
  questions: DeciderQuestions;
  input: unknown;
}): Promise<DecisionOutcome> => {
  const { text, images } = parseDecisionInput(args.input);
  const frame = renderDeciderFrame({
    questions: args.questions,
    inputText: text,
  });
  const result = await createGeneration({
    projectIds: args.projectIds,
    agentId: args.agentPublicId,
    messages: [
      {
        role: 'user',
        content:
          images.length === 0
            ? frame
            : [
                { type: 'text', text: frame },
                ...images.map((image) => {
                  return { type: 'image', image };
                }),
              ],
      },
    ],
    stream: false,
    // The version whose tool surface was checked at admission, so an edit
    // landing mid-evaluation cannot hand the generation a tool.
    pinnedAgentVersion: args.agentVersion,
    source: DECIDER_USAGE_SOURCE,
    outputSchemaOverride: compileAnswerSchema(args.questions),
  });
  return outcomeOf({ result, questions: args.questions });
};

export type DecisionEvaluation = {
  answer: () => Promise<DecisionOutcome>;
  opaqueFailure: StoredError;
};

/**
 * Checks the backend can answer, then returns how it will. Every check here
 * runs before the decision is written, so a refusal is a `4xx`.
 */
export const admitDecisionBackend = async (args: {
  projectIds?: number[];
  projectId: number;
  agent: DeciderAgentRow | null;
  tool: DeciderToolRow | null;
  questions: DeciderQuestions;
  input: unknown;
  authHeader?: string;
}): Promise<DecisionEvaluation> => {
  const { agent, tool, questions, input } = args;
  parseDecisionInput(input);
  if (tool) {
    assertDeciderToolCallable(tool);
    await assertProjectAcceptsWork({ projectId: args.projectId });
    return {
      answer: async () => {
        return {
          status: 'completed',
          answers: await answerWithTool({
            projectId: args.projectId,
            toolPublicId: tool.publicId,
            questions,
            input,
            authHeader: args.authHeader,
          }),
          generationId: null,
        };
      },
      opaqueFailure: TOOL_FAILURE,
    };
  }
  /* istanbul ignore next -- a decision names exactly one backend. */
  if (!agent) {
    throw new DomainError('INTERNAL_ERROR', 'Decision has no backend.');
  }
  assertDeciderAgentToolLess(agent);
  await assertProjectAcceptsWork({ projectId: args.projectId });
  const breach = await checkGenerationQuota({
    agentId: agent.publicId,
    projectIds: args.projectIds,
  });
  if (breach) throw quotaBreachError(breach);
  return {
    answer: () => {
      return answerWithAgent({
        projectIds: args.projectIds,
        agentPublicId: agent.publicId,
        agentVersion: agent.version,
        questions,
        input,
      });
    },
    opaqueFailure: GENERATION_FAILURE,
  };
};
