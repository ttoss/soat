/**
 * The seam a `loop` or `sub_orchestration` node uses to start a child run.
 *
 * Those two nodes are the only reason the node executors ever needed the
 * engine, and the engine needs the executors back to dispatch a node — a real
 * runtime import cycle (#910). Importing the engine dynamically breaks it: a
 * dynamic import is resolved when the call is made, not when the module graph
 * is built, so nothing here appears in the engine's load-time dependencies.
 *
 * Deliberately branch-free. An earlier version registered the starter up front
 * (the shape `registerApprovalResumeHandler` uses) and fell back to this import
 * when nothing had registered — but every path that reaches a loop node runs
 * *through* the engine, so the unregistered branch was unreachable by
 * construction. Per `.claude/rules/tests.md`, a branch no entry point can reach
 * is dead code to delete, not a case to test.
 */

export type NestedRunStarter = (args: {
  orchestrationPublicId: string;
  projectId?: number;
  projectIds: number[];
  input: Record<string, unknown>;
  authHeader?: string;
  // The parent run's `tool_context`, inherited by the child so an agent several
  // levels down still calls its tools with the caller's context (#945).
  toolContext?: Record<string, string>;
  wait: boolean;
}) => Promise<{ output: Record<string, unknown> | null }>;

export const startNestedRun: NestedRunStarter = async (args) => {
  const { startOrchestrationRun } = await import('./orchestrationEngine');
  return startOrchestrationRun(args);
};
