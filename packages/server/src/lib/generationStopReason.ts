import { DEFAULT_MAX_STEPS } from './agentGenerationTypes';
import { isPlainObject } from './plainObject';

/** The agent's `max_steps`, or the platform default when it names none. */
export const resolveMaxSteps = (maxSteps: unknown): number => {
  return typeof maxSteps === 'number' ? maxSteps : DEFAULT_MAX_STEPS;
};

/** The agent fields that decide how a turn ends on its step budget. */
export type TurnBudget = {
  maxSteps: unknown;
  outputSchema: unknown;
};

/**
 * Why a turn ended, as the platform sees it — which is not always what the
 * provider reported.
 *
 * A turn that spends its entire step budget proposing tool calls finishes on
 * the provider's `tool-calls`, the same value a turn that stopped mid-loop with
 * work still outstanding reports. `max_steps` separates the two
 * (`modules/agents.md` — Stop Reason). An `output_schema` agent's last allowed
 * step answers without tools (`resolveAnswerStep`), so reaching the budget is
 * `max_steps` whatever that step's finish reason.
 *
 * Only the exhaustion case is renamed; every other finish reason is the
 * provider's own, relayed unchanged.
 */
export const resolveStopReason = (args: {
  finishReason: string;
  stepCount: number;
  budget: TurnBudget;
}): string => {
  const exhausted = args.stepCount >= resolveMaxSteps(args.budget.maxSteps);
  const endsOnBudget =
    args.finishReason === 'tool-calls' ||
    isPlainObject(args.budget.outputSchema);
  return exhausted && endsOnBudget ? 'max_steps' : args.finishReason;
};
