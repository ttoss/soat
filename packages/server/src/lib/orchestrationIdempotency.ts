import createDebug from 'debug';

import { db } from '../db';
import type { NodeExecutionResult } from './orchestrationExecutors';
import type { OrchestrationNode } from './orchestrations';

const log = createDebug('soat:orchestrations');

// Node types with an external side effect (a tool/HTTP call, an agent
// generation, a memory write, an emitted event, a child run). These are keyed
// for run-scoped idempotency (D5): the keyed `running` record is written before
// dispatch and updated in place, so a redelivered task that finds a `completed`
// key reuses the stored output instead of re-executing the side effect. Pure
// nodes (condition/transform/delay/human/approval/webhook) and re-attempting
// nodes (poll manages its own attempt loop) keep record-after-execution.
const SIDE_EFFECTING_NODE_TYPES = new Set([
  'agent',
  'tool',
  'memory_write',
  'emit_event',
  'sub_orchestration',
  'loop',
]);

/**
 * The run-scoped idempotency key for a node execution: `{run_id}:{node_id}:
 * {attempt}` where `attempt` is the node **retry** attempt (D2). Null for pure /
 * non-keyed node types, so they keep record-after-execution behavior.
 */
export const computeNodeIdempotencyKey = (args: {
  runPublicId: string | null | undefined;
  nodeId: string;
  nodeType: string | null;
  attempt: number;
}): string | null => {
  if (!args.runPublicId || !args.nodeType) return null;
  if (!SIDE_EFFECTING_NODE_TYPES.has(args.nodeType)) return null;
  return `${args.runPublicId}:${args.nodeId}:${args.attempt}`;
};

const isUniqueViolation = (error: unknown): boolean => {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: string }).name === 'SequelizeUniqueConstraintError'
  );
};

const findNodeExecutionByKey = (key: string) => {
  return db.OrchestrationNodeExecution.findOne({
    where: { idempotencyKey: key },
  });
};

export type ReservedRow = InstanceType<typeof db.OrchestrationNodeExecution>;

/** The `{ nodeId, nodeDefn, execResult }` shape both the executor and the
 * idempotency replay path return. */
export type NodeOutcome = {
  nodeId: string;
  nodeDefn: OrchestrationNode;
  execResult: NodeExecutionResult;
};

/**
 * Builds the executor-equivalent result for a node whose side effect already
 * ran under this idempotency key — its stored output is replayed as an
 * `artifact` result, so downstream state mapping and successor activation
 * behave exactly as if the executor had just run.
 */
const reuseCompletedResult = (args: {
  nodeId: string;
  nodeDefn: OrchestrationNode;
  output: object | null;
}): NodeOutcome => {
  return {
    nodeId: args.nodeId,
    nodeDefn: args.nodeDefn,
    execResult: {
      kind: 'artifact',
      artifact: (args.output ?? {}) as Record<string, unknown>,
    },
  };
};

/**
 * Reserves the idempotency key with a `running` record written *before* the
 * side effect runs (D5). Returns the reserved row to update after dispatch, or —
 * when a concurrent worker already completed this key — the stored output to
 * reuse without dispatching.
 */
const reserveKeyedRunningRow = async (args: {
  runRecord: InstanceType<typeof db.OrchestrationRun>;
  nodeId: string;
  nodeType: string | null;
  attempt: number;
  input: Record<string, unknown> | null;
  key: string;
  startedAt: Date;
}): Promise<
  { kind: 'row'; row: ReservedRow } | { kind: 'reuse'; output: object | null }
> => {
  try {
    const row = await db.OrchestrationNodeExecution.create({
      runId: args.runRecord.id as number,
      nodeId: args.nodeId,
      nodeType: args.nodeType,
      attempt: args.attempt,
      status: 'running',
      input: args.input,
      output: null,
      error: null,
      startedAt: args.startedAt,
      completedAt: null,
      idempotencyKey: args.key,
    });
    return { kind: 'row', row };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Another worker holds this key. If it already completed, reuse its output;
    // otherwise take over the existing `running`/`failed` row under the same key
    // (the honest at-least-once boundary — see the PRD's idempotency contract).
    const existing = await findNodeExecutionByKey(args.key);
    if (existing?.status === 'completed') {
      return { kind: 'reuse', output: existing.output };
    }
    if (existing) {
      await existing.update({
        status: 'running',
        input: args.input,
        output: null,
        error: null,
        startedAt: args.startedAt,
        completedAt: null,
      });
      return { kind: 'row', row: existing };
    }
    throw error;
  }
};

/**
 * Resolves the idempotency state for a keyed node before dispatch: returns a
 * `reuse` outcome to short-circuit when the key already completed, or the
 * `keyedRow` (a `running` record) to update after the side effect runs. For
 * non-keyed nodes (no key or missing definition) returns an empty object and
 * the caller records after execution as before.
 */
export const prepareKeyedExecution = async (args: {
  idempotencyKey: string | null;
  nodeDefn: OrchestrationNode | undefined;
  nodeId: string;
  nodeType: string | null;
  attempt: number;
  input: Record<string, unknown> | null;
  runRecord: InstanceType<typeof db.OrchestrationRun>;
  startedAt: Date;
}): Promise<{ reuse?: NodeOutcome; keyedRow?: ReservedRow }> => {
  const { idempotencyKey, nodeDefn, nodeId } = args;
  if (!idempotencyKey || !nodeDefn) return {};

  const done = await findNodeExecutionByKey(idempotencyKey);
  if (done?.status === 'completed') {
    log('prepareKeyedExecution: reusing completed key=%s', idempotencyKey);
    return {
      reuse: reuseCompletedResult({ nodeId, nodeDefn, output: done.output }),
    };
  }

  const reserved = await reserveKeyedRunningRow({
    runRecord: args.runRecord,
    nodeId,
    nodeType: args.nodeType,
    attempt: args.attempt,
    input: args.input,
    key: idempotencyKey,
    startedAt: args.startedAt,
  });
  if (reserved.kind === 'reuse') {
    log('prepareKeyedExecution: reusing raced key=%s', idempotencyKey);
    return {
      reuse: reuseCompletedResult({
        nodeId,
        nodeDefn,
        output: reserved.output,
      }),
    };
  }
  return { keyedRow: reserved.row };
};
