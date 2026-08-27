import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * How many event-trigger hops one causal chain may take before the platform
 * refuses to extend it.
 *
 * The same idea as the nested `sub_orchestration` depth limit and the task
 * engine's automation chain budget: a reactive edge that feeds itself is a
 * cycle no validator can see, because each half is legitimate on its own. The
 * cap is a backstop, not a design — reaching it files an exception rather than
 * failing quietly, because a loop running unattended is worth an alert.
 */
export const MAX_EVENT_CAUSATION_DEPTH = 5;

/**
 * The chain of trigger public ids that led to the work currently executing,
 * oldest first. Empty for anything a caller started directly.
 *
 * It is carried in `AsyncLocalStorage` rather than threaded through every
 * emit site because the chain has to survive an arbitrary amount of execution
 * between the firing and the event it eventually causes — a generation, a whole
 * orchestration run, a fire-and-forget write. Every such continuation inherits
 * the store automatically, so no producer needs to know that a trigger is
 * somewhere above it. `emitEnvelope` stamps what it reads here onto the
 * envelope, which is what makes the chain visible to the next subscriber.
 */
const causationStore = new AsyncLocalStorage<readonly string[]>();

/** The chain in scope for the current execution, or an empty chain. */
export const currentCausationChain = (): readonly string[] => {
  return causationStore.getStore() ?? [];
};

/**
 * Runs `fn` with `chain` in scope. Everything it awaits — and everything it
 * leaves running in the background — sees the same chain.
 */
export const runWithCausationChain = <T>(args: {
  chain: readonly string[];
  fn: () => T;
}): T => {
  return causationStore.run(args.chain, args.fn);
};
