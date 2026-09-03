/**
 * The seam a `loop` or `sub_orchestration` node uses to start a child run.
 *
 * Those two nodes are the only reason the executors need the engine, and the
 * engine needs the executors back — a real runtime cycle (#910). A dynamic
 * import is resolved at call time, not when the module graph is built, so
 * nothing here appears in the engine's load-time dependencies.
 *
 * Deliberately branch-free: an earlier version fell back to this import when
 * nothing had registered a starter, but every path reaching a loop node runs
 * *through* the engine, so that branch was unreachable — dead code to delete,
 * not a case to test (`.claude/rules/tests.md`).
 */

/**
 * The run and node a nested run descends from. One object rather than two loose
 * ids so the pair travels together: a child with a node but no run, or the
 * reverse, is not a state the engine should be able to express.
 *
 * Declared here, in the seam both sides already depend on, so neither the
 * engine nor the executors have to import the other for it.
 */
export type NestedRunParent = {
  runId?: string;
  nodeId: string;
  /**
   * The parent run's own `run_depth`, so the child's is one more than it. Read
   * off the parent's row by the engine driving it rather than looked up from
   * `runId` here: the row is already in hand there, and a child started by a
   * parent whose row had since been deleted would otherwise restart the count
   * from zero — the unbounded case by another route (#1185).
   */
  runDepth: number;
};

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
  // Stamped on the child so a parent's cost roll-up reaches the work it ordered
  // (#1135). Deliberately outside the public contract: parentage is recorded by
  // the engine executing the parent, never claimed by a caller.
  parent: NestedRunParent;
}) => Promise<{
  id: string;
  status: string;
  output: Record<string, unknown> | null;
  error: object | null;
}>;

export const startNestedRun: NestedRunStarter = async (args) => {
  const { startOrchestrationRun } = await import('./orchestrationEngine');
  return startOrchestrationRun(args);
};
