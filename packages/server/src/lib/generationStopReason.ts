import { DEFAULT_MAX_STEPS } from './agentGenerationTypes';

/** The agent's `max_steps`, or the platform default when it names none. */
export const resolveMaxSteps = (maxSteps: unknown): number => {
  return typeof maxSteps === 'number' ? maxSteps : DEFAULT_MAX_STEPS;
};

/**
 * Why a turn ended, as the platform sees it — which is not always what the
 * provider reported.
 *
 * A turn that spends its entire step budget proposing tool calls finishes on
 * the provider's `tool-calls`, the same value a turn that stopped mid-loop with
 * work still outstanding reports. So "this agent cannot terminate on its own"
 * read exactly like ordinary tool use on the generation record, which is what
 * let a forced-tool agent loop unnoticed. `max_steps` separates the two
 * (`modules/agents.md` — Stop Reason).
 *
 * Only the exhaustion case is renamed; every other finish reason is the
 * provider's own, relayed unchanged.
 */
export const resolveStopReason = (args: {
  finishReason: string;
  stepCount: number;
  /** The agent's `max_steps`; `unknown` because `TypedAgent` carries it untyped. */
  maxSteps: unknown;
}): string => {
  return args.finishReason === 'tool-calls' &&
    args.stepCount >= resolveMaxSteps(args.maxSteps)
    ? 'max_steps'
    : args.finishReason;
};
