/**
 * How deep a `loop` / `sub_orchestration` run tree may go.
 *
 * Nesting is unbounded by construction: a `sub_orchestration` node naming its
 * own graph — directly, or through a cycle of two graphs — starts a child run
 * that starts a child run, and nothing intra-graph can see it
 * (`detectCycleExcludingLoopNodes` is intra-graph by construction, and excludes
 * loop nodes deliberately). None of the platform's other bounds reaches it
 * either: `Task.automationChainDepth` bounds the workflow↔dispatch cycle (a
 * nested run transitions no task), `max_call_depth` bounds agent→agent
 * recursion through tool calls (a `sub_orchestration` node is not a tool call),
 * and `maxChainGenerations` bounds one agent chain (each child run meters its
 * own). So the runaway was bounded only by whatever ran out first — queue
 * capacity, the project's concurrency limit, provider spend — and the failure
 * that eventually surfaced named nothing about the real cause (#1185).
 */
import { db } from '../db';
import { DomainError } from '../errors';

/**
 * Nesting levels a run tree may reach on this deployment.
 *
 * 10 matches `max_call_depth`, the closest analog: both bound synchronous
 * recursion started by a resource pointing at another. Deep composition is rare
 * — a graph delegating to a graph delegating to a graph is already unusual — so
 * the headroom is generous while an accidental self-reference still stops after
 * a handful of runs instead of filling the queue.
 *
 * A depth bound, not a population one: a `loop` node fans out, so N children
 * per level still permits N^depth runs. Bounding the width is `parallelism`
 * and the project's `max_concurrent_runs`; this bounds the recursion.
 */
const DEFAULT_MAX_ORCHESTRATION_RUN_DEPTH = 10;

export const maxOrchestrationRunDepth = (): number => {
  const configured = Number(process.env.MAX_ORCHESTRATION_RUN_DEPTH);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_ORCHESTRATION_RUN_DEPTH;
};

/** Which ceiling refused the child — the project's, or the deployment's. */
export type RunDepthLimitSource = 'project' | 'platform';

/**
 * The bound this run tree is held to: the smaller of the deployment's ceiling
 * and the project's own.
 *
 * `min` rather than "the project's if it sets one", for the same reason
 * `resolveEffectiveLimit` uses it for chains: a narrower scope exists so its
 * owner can be *stricter*, and letting it raise the ceiling would make the
 * outer bound opt-out — which is the one thing it cannot be, since the graph
 * that runs away is exactly the one whose config is wrong.
 *
 * Ties go outward (`<`, not `<=`): where both name the same number the broader
 * one is reported, because raising the project's alone would not move the bound.
 *
 * Read at spawn time rather than pinned on the tree's root, so lowering the
 * number stops a tree that is already recursing.
 */
export const resolveEffectiveRunDepthLimit = async (args: {
  projectId: number;
}): Promise<{ limit: number; limitSource: RunDepthLimitSource }> => {
  const platform = maxOrchestrationRunDepth();

  const project = await db.Project.findOne({
    where: { id: args.projectId },
    attributes: ['maxRunDepth'],
  });
  const declared = project?.maxRunDepth;

  if (
    typeof declared === 'number' &&
    Number.isInteger(declared) &&
    declared > 0 &&
    declared < platform
  ) {
    return { limit: declared, limitSource: 'project' };
  }
  return { limit: platform, limitSource: 'platform' };
};

/**
 * The depth to persist on a child run, or a throw when starting it would breach
 * the bound.
 *
 * Refuses *before* the child's row exists, so the runaway leaves no queued run
 * behind and the error surfaces on the parent — the run that chose to descend —
 * where its `parent_orchestration_run_id` chain names every hop that led there.
 */
export const nextRunDepthOrRefuse = async (args: {
  projectId: number;
  parentRunDepth: number;
  parentRunId?: string;
  orchestrationPublicId: string;
}): Promise<number> => {
  const next = args.parentRunDepth + 1;
  const { limit, limitSource } = await resolveEffectiveRunDepthLimit({
    projectId: args.projectId,
  });

  if (next > limit) {
    throw new DomainError(
      'ORCHESTRATION_RUN_DEPTH_LIMIT',
      `Starting a child run of orchestration '${args.orchestrationPublicId}' would reach nesting depth ${next}, past the limit of ${limit}; the graph is recursing through its loop / sub_orchestration nodes.`,
      {
        orchestrationId: args.orchestrationPublicId,
        parentOrchestrationRunId: args.parentRunId ?? null,
        depth: next,
        limit,
        limitSource,
      }
    );
  }

  return next;
};
