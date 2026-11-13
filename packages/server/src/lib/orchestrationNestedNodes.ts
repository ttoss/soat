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
import { DomainError } from '../errors';
import { applyInputMapping } from './jsonLogicMapping';
import {
  type LoopItemError,
  type LoopItemStart,
  resolveLoopItemStarts,
} from './orchestrationLoopItemContext';
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
import type { WorkAuthority } from './workAuthority';

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
  // Items that started no child, each slotted back at its `index`.
  itemErrors: LoopItemError[];
}): Record<string, unknown> => {
  const { node, runs } = args;
  if (node.type !== 'loop') {
    assertNestedRunCompleted({ run: runs[0], nodeId: node.id });
    return runs[0].output ?? {};
  }
  const itemErrors = new Map(
    args.itemErrors.map((itemError) => {
      return [itemError.index, itemError];
    })
  );
  const pending = [...runs];
  let failedCount = 0;
  const total = runs.length + itemErrors.size;
  const results = Array.from({ length: total }, (_, index) => {
    const itemError = itemErrors.get(index);
    if (itemError) {
      failedCount += 1;
      return { error: { code: itemError.code, message: itemError.message } };
    }
    const run = pending.shift()!;
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
  itemErrors: LoopItemError[];
}): NodeExecutionResult => {
  const { node, runs, itemErrors } = args;
  const parked = runs.some((run) => {
    return !isNestedRunSettled(run.status);
  });
  if (!parked) {
    return {
      kind: 'artifact',
      artifact: nestedNodeArtifact({ node, runs, itemErrors }),
    };
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
      ...(itemErrors.length > 0 ? { item_errors: itemErrors } : {}),
    },
  };
};

const runLoopBatches = async (args: {
  starts: LoopItemStart[];
  parallelism: number;
  itemVariable: string;
  onItemError: LoopItemErrorMode;
  orchestrationId: string;
  projectIds: number[];
  authority: WorkAuthority | null;
  parent: NestedRunParent;
}): Promise<NestedRunResult[]> => {
  const {
    starts,
    parallelism,
    itemVariable,
    onItemError,
    orchestrationId,
    projectIds,
    authority,
    parent,
  } = args;
  const runs: NestedRunResult[] = [];
  for (let i = 0; i < starts.length; i += parallelism) {
    const batch = starts.slice(i, i + parallelism);
    const batchResults = await Promise.all(
      batch.map((start) => {
        const itemInput: Record<string, unknown> = {
          [itemVariable]: start.item,
        };
        return startNestedRun({
          orchestrationPublicId: orchestrationId,
          projectIds,
          input: itemInput,
          authority,
          // Narrowed by `contextKeys`, then overlaid by `itemToolContext`.
          toolContext: start.toolContext,
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
  authority: WorkAuthority | null;
  toolContext?: Record<string, string>;
  runPublicId?: string;
  runDepth: number;
}): Promise<NodeExecutionResult> => {
  const { node, state, projectIds, authority, toolContext, runPublicId } = args;
  const orchestrationId = requireNodeField(node, 'orchestrationId');

  const collectionPath = node.collection ?? 'state.items';
  const itemVariable = node.itemVariable ?? 'item';
  const parallelism = node.parallelism ?? 5;
  const onItemError = node.onItemError ?? 'fail';
  const { starts, itemErrors } = resolveLoopItemStarts({
    items: resolveLoopCollection({ collectionPath, state }),
    itemVariable,
    itemToolContext: node.itemToolContext,
    state,
    inherited: filterToolContext({
      toolContext,
      contextKeys: node.contextKeys,
    }),
  });
  const [firstError] = itemErrors;
  if (firstError && onItemError === 'fail') {
    throw new DomainError(firstError.code, firstError.message, {
      node_id: node.id,
      item_index: firstError.index,
    });
  }
  const runs = await runLoopBatches({
    starts,
    parallelism,
    itemVariable,
    onItemError,
    orchestrationId,
    projectIds,
    authority,
    parent: { runId: runPublicId, nodeId: node.id, runDepth: args.runDepth },
  });

  return settleNestedNode({ node, runs, itemErrors });
};

export const executeSubOrchestrationNode = async (args: {
  node: OrchestrationNode;
  state: Record<string, unknown>;
  projectIds: number[];
  traceId: string | null;
  authority: WorkAuthority | null;
  toolContext?: Record<string, string>;
  runPublicId?: string;
  runDepth: number;
}): Promise<NodeExecutionResult> => {
  const { node, state, projectIds, authority, toolContext, runPublicId } = args;
  const orchestrationId = requireNodeField(node, 'orchestrationId');

  const input = applyInputMapping(node.inputMapping, state);
  const run = await startNestedRun({
    orchestrationPublicId: orchestrationId,
    projectIds,
    input,
    authority,
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

  return settleNestedNode({ node, runs: [run], itemErrors: [] });
};
