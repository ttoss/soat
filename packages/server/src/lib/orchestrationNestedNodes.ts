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
import { requireNodeField } from './orchestrationNodeFields';
import type { NodeExecutionResult } from './orchestrationNodeTypes';
import type { OrchestrationNode } from './orchestrations';
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

const runLoopBatches = async (args: {
  items: unknown[];
  parallelism: number;
  itemVariable: string;
  orchestrationId: string;
  projectIds: number[];
  authHeader?: string;
  toolContext?: Record<string, string>;
  parent: NestedRunParent;
}): Promise<unknown[]> => {
  const {
    items,
    parallelism,
    itemVariable,
    orchestrationId,
    projectIds,
    authHeader,
    toolContext,
    parent,
  } = args;
  const results: unknown[] = [];
  for (let i = 0; i < items.length; i += parallelism) {
    const batch = items.slice(i, i + parallelism);
    const batchResults = await Promise.all(
      batch.map((item) => {
        const itemInput: Record<string, unknown> = { [itemVariable]: item };
        return startNestedRun({
          orchestrationPublicId: orchestrationId,
          projectId: projectIds[0],
          projectIds,
          input: itemInput,
          authHeader,
          // Already narrowed by the node's `contextKeys` in `executeLoopNode`.
          toolContext,
          // Every item's run is attributable to the node that fanned it out, so
          // the loop's real cost is the sum of its children (#1135).
          parent,
          // Nested runs must complete synchronously so their output can be
          // aggregated into this loop node's artifact.
          wait: true,
        });
      })
    );
    results.push(
      ...batchResults.map((r) => {
        return r.output;
      })
    );
  }
  return results;
};

export const executeLoopNode = async (args: {
  node: OrchestrationNode;
  state: Record<string, unknown>;
  projectIds: number[];
  traceId: string | null;
  authHeader?: string;
  toolContext?: Record<string, string>;
  runPublicId?: string;
}): Promise<NodeExecutionResult> => {
  const { node, state, projectIds, authHeader, toolContext, runPublicId } =
    args;
  const orchestrationId = requireNodeField(node, 'orchestrationId');

  const collectionPath = node.collection ?? 'state.items';
  const itemVariable = node.itemVariable ?? 'item';
  const parallelism = node.parallelism ?? 5;
  const items = resolveLoopCollection({ collectionPath, state });
  const results = await runLoopBatches({
    items,
    parallelism,
    itemVariable,
    orchestrationId,
    projectIds,
    authHeader,
    toolContext: filterToolContext({
      toolContext,
      contextKeys: node.contextKeys,
    }),
    parent: { runId: runPublicId, nodeId: node.id },
  });

  return { kind: 'artifact', artifact: { results } };
};

export const executeSubOrchestrationNode = async (args: {
  node: OrchestrationNode;
  state: Record<string, unknown>;
  projectIds: number[];
  traceId: string | null;
  authHeader?: string;
  toolContext?: Record<string, string>;
  runPublicId?: string;
}): Promise<NodeExecutionResult> => {
  const { node, state, projectIds, authHeader, toolContext, runPublicId } =
    args;
  const orchestrationId = requireNodeField(node, 'orchestrationId');

  const input = applyInputMapping(node.inputMapping, state);
  const run = await startNestedRun({
    orchestrationPublicId: orchestrationId,
    projectId: projectIds[0],
    projectIds,
    input,
    authHeader,
    // A child run is still this run's work, so it inherits the parent's context
    // rather than starting with none (#945) — narrowed to the node's
    // `contextKeys` when it sets one (#1153).
    toolContext: filterToolContext({
      toolContext,
      contextKeys: node.contextKeys,
    }),
    // The child is this node's work: its spend rolls up to this run (#1135).
    parent: { runId: runPublicId, nodeId: node.id },
    // A sub-orchestration is a synchronous child: its terminal output feeds this
    // node's artifact, so it must run to completion before continuing.
    wait: true,
  });

  return { kind: 'artifact', artifact: run.output ?? {} };
};
