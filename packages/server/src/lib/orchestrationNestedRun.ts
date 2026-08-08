/**
 * The seam a `loop` or `sub_orchestration` node uses to start a child run.
 *
 * Those two nodes are the only reason the node executors ever needed the
 * engine, and the engine needs the executors back to dispatch a node — a real
 * runtime import cycle (#910). This inverts the edge with the pattern the
 * codebase already uses for approvals (`registerApprovalResumeHandler`): the
 * engine registers its starter when it loads, and the node executors call
 * through this registry without naming the engine.
 */

export type NestedRunStarter = (args: {
  orchestrationPublicId: string;
  projectId?: number;
  projectIds: number[];
  input: Record<string, unknown>;
  authHeader?: string;
  wait: boolean;
}) => Promise<{ output: Record<string, unknown> | null }>;

let starter: NestedRunStarter | null = null;

export const registerNestedRunStarter = (handler: NestedRunStarter): void => {
  starter = handler;
};

/**
 * Starts a nested run through the registered starter.
 *
 * When nothing has registered yet — a caller that reached a loop node without
 * the engine module ever being loaded, which the previous static import made
 * impossible — the engine is imported dynamically and registers itself as a
 * side effect of loading. The import is dynamic precisely so it creates no
 * static edge back into this module's importers, which is the whole point of
 * the seam.
 */
export const startNestedRun: NestedRunStarter = async (args) => {
  if (!starter) {
    await import('./orchestrationEngine');
  }
  if (!starter) {
    throw new Error(
      'No nested-run starter registered; orchestrationEngine did not load.'
    );
  }
  return starter(args);
};
