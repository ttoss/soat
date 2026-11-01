/**
 * The two node types that start a **child run**: `loop`, which fans one out per
 * item of a collection, and `sub_orchestration`, which delegates a single step
 * to another graph.
 *
 * Their own module because they are the only executors that reach back into the
 * engine (through the `startNestedRun` seam), and because the parent→child edge
 * carries a containment rule the other node types have no equivalent of — see
 * `contextKeys` below.
 */
import { applyInputMapping } from './jsonLogicMapping';
import { type NestedRunParent, startNestedRun } from './orchestrationNestedRun';
import {
  assertNestedRunCompleted,
  isNestedRunSettled,
  readNestedRunFailure,
} from './orchestrationNestedRunOutcome';
import { requireNodeField } from './orchestrationNodeFields';
import type { NodeExecutionResult } from './orchestrationNodeTypes';
import type { LoopItemErrorMode, OrchestrationNode } from './orchestrations';
import { filterToolContext } from './toolContext';

const resolveLoopCollection = (args: {
  collectionPath: string;
  state: Record<string, unknown>;
}): unknown[] => {
  const { collectionPath, state } = args;
  const normalizedPath = collectionPath.startsWith('state.')
    ? collectionPath
    : `state.${collectionPath}`;
  const parts = normalizedPath.slice('state.'.length).split('.');
  let cursor: unknown = state;
  for (const part of parts) {
    if (cursor === null || typeof cursor !== 'object') return [];
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return Array.isArray(cursor) ? cursor : [];
};

/** A child run as the node reads it, whether just started or loaded back. */
export type NestedRunResult = {
  id: string;
  status: string;
  output: Record<string, unknown> | null;
  error: object | null;
};

/**
 * The artifact a `loop` / `sub_orchestration` node takes from its settled
 * child runs (in item order), or the throw that fails it. The one reading both
 * the inline drive and a parked node's wake use.
 */
export const nestedNodeArtifact = (args: {
  node: Pick<OrchestrationNode, 'id' | 'type' | 'onItemError'>;
  runs: NestedRunResult[];
}): Record<string, unknown> => {
  const { node, runs } = args;
  if (node.type !== 'loop') {
    assertNestedRunCompleted({ run: runs[0], nodeId: node.id });
    return runs[0].output ?? {};
  }
  let failedCount = 0;
  const results = runs.map((run) => {
    if ((node.onItemError ?? 'fail') === 'fail') {
      assertNestedRunCompleted({ run, nodeId: node.id });
      return run.output;
    }
    const failure = readNestedRunFailure({ run, nodeId: node.id });
    if (!failure) return run.output;
    failedCount += 1;
    return {
      error: { code: failure.code, message: failure.message },
      orchestration_run_id: run.id,
    };
  });
  return { results, failed_count: failedCount };
};

/**
 * The node's result once its children ran: its artifact, or a park on the
 * children that have not settled, which their settle resumes.
 */
const settleNestedNode = (args: {
  node: OrchestrationNode;
  runs: NestedRunResult[];
}): NodeExecutionResult => {
  const { node, runs } = args;
  const parked = runs.some((run) => {
    return !isNestedRunSettled(run.status);
  });
  if (!parked) {
    return { kind: 'artifact', artifact: nestedNodeArtifact({ node, runs }) };
  }
  return {
    kind: 'requires_action',
    type: 'child_run',
    nodeId: node.id,
    prompt: `Node '${node.id}' waits for its child runs to settle.`,
    context: {
      orchestration_run_ids: runs.map((run) => {
        return run.id;
      }),
    },
  };
};

const runLoopBatches = async (args: {
  items: unknown[];
  parallelism: number;
  itemVariable: string;
  onItemError: LoopItemErrorMode;
  orchestrationId: string;
  projectIds: number[];
  authHeader?: string;
  toolContext?: Record<string, string>;
  parent: NestedRunParent;
}): Promise<NestedRunResult[]> => {
  const {
    items,
    parallelism,
    itemVariable,
    onItemError,
    orchestrationId,
    projectIds,
    authHeader,
    toolContext,
    parent,
  } = args;
  const runs: NestedRunResult[] = [];
  for (let i = 0; i < items.length; i += parallelism) {
    const batch = items.slice(i, i + parallelism);
    const batchResults = await Promise.all(
      batch.map((item) => {
        const itemInput: Record<string, unknown> = { [itemVariable]: item };
        return startNestedRun({
          orchestrationPublicId: orchestrationId,
          projectIds,
          input: itemInput,
          authHeader,
          // Already narrowed by the node's `contextKeys` in `executeLoopNode`.
          toolContext,
          // Every item's run is attributable to the node that fanned it out, so
          // the loop's real cost is the sum of its children.
          parent,
          // Each item runs to a resting point: a settled one feeds this node's
          // artifact, a parked one parks the node (`settleNestedNode`).
          wait: true,
        });
      })
    );
    // Under `fail`, a settled failure stops the next batch from starting.
    if (onItemError === 'fail') {
      for (const run of batchResults) {
        assertNestedRunCompleted({ run, nodeId: parent.nodeId });
      }
    }
    runs.push(...batchResults);
  }
  return runs;
};

export const executeLoopNode = async (args: {
  node: OrchestrationNode;
  state: Record<string, unknown>;
  projectIds: number[];
  traceId: string | null;
  authHeader?: string;
  toolContext?: Record<string, string>;
  runPublicId?: string;
  runDepth: number;
}): Promise<NodeExecutionResult> => {
  const { node, state, projectIds, authHeader, toolContext, runPublicId } =
    args;
  const orchestrationId = requireNodeField(node, 'orchestrationId');

  const collectionPath = node.collection ?? 'state.items';
  const itemVariable = node.itemVariable ?? 'item';
  const parallelism = node.parallelism ?? 5;
  const items = resolveLoopCollection({ collectionPath, state });
  const runs = await runLoopBatches({
    items,
    parallelism,
    itemVariable,
    onItemError: node.onItemError ?? 'fail',
    orchestrationId,
    projectIds,
    authHeader,
    toolContext: filterToolContext({
      toolContext,
      contextKeys: node.contextKeys,
    }),
    parent: { runId: runPublicId, nodeId: node.id, runDepth: args.runDepth },
  });

  return settleNestedNode({ node, runs });
};

export const executeSubOrchestrationNode = async (args: {
  node: OrchestrationNode;
  state: Record<string, unknown>;
  projectIds: number[];
  traceId: string | null;
  authHeader?: string;
  toolContext?: Record<string, string>;
  runPublicId?: string;
  runDepth: number;
}): Promise<NodeExecutionResult> => {
  const { node, state, projectIds, authHeader, toolContext, runPublicId } =
    args;
  const orchestrationId = requireNodeField(node, 'orchestrationId');

  const input = applyInputMapping(node.inputMapping, state);
  const run = await startNestedRun({
    orchestrationPublicId: orchestrationId,
    projectIds,
    input,
    authHeader,
    // A child run is still this run's work, so it inherits the parent's context
    // rather than starting with none — narrowed to the node's
    // `contextKeys` when it sets one.
    toolContext: filterToolContext({
      toolContext,
      contextKeys: node.contextKeys,
    }),
    // The child is this node's work: its spend rolls up to this run.
    parent: { runId: runPublicId, nodeId: node.id, runDepth: args.runDepth },
    // Driven to a resting point: a settled child feeds this node's artifact,
    // a parked one parks the node (`settleNestedNode`).
    wait: true,
  });

  return settleNestedNode({ node, runs: [run] });
};
