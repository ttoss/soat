import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import type { NodeExecutionResult } from './orchestrationExecutors';
import { applyInputMapping, executeNodeById } from './orchestrationExecutors';
import type { NodeOutcome, ReservedRow } from './orchestrationIdempotency';
import {
  computeNodeIdempotencyKey,
  prepareKeyedExecution,
} from './orchestrationIdempotency';
import {
  backoffMs,
  isRetriableError,
  resolveRetryPolicy,
} from './orchestrationRetry';
import type { OrchestrationNode } from './orchestrations';

const log = createDebug('soat:orchestrations');

/**
 * Normalizes any thrown value into the structured error shape persisted on a
 * run (and on each failing node execution).
 */
const describeThrown = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  // A non-Error throw is common from third-party evaluators — e.g.
  // json-logic-engine throws a bare `{ type: 'Unknown Operator' }` object for
  // an unrecognized operator (such as a multi-key object used as a
  // `map`/`filter` mapper). `String(obj)` collapses that to the useless
  // "[object Object]", so serialize the value to preserve the actual cause.
  if (typeof error === 'object' && error !== null) {
    try {
      const json = JSON.stringify(error);
      if (json && json !== '{}') return json;
    } catch {
      // fall through to String() for circular / non-serializable values
    }
  }
  return String(error);
};

export const buildRunError = (error: unknown): object => {
  return {
    message: describeThrown(error),
    code: error instanceof DomainError ? error.code : 'UNKNOWN',
  };
};

const recordNodeExecution = async (args: {
  runRecord: InstanceType<typeof db.OrchestrationRun>;
  nodeId: string;
  nodeType: string | null;
  status: 'running' | 'completed' | 'failed' | 'requires_action' | 'skipped';
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: object | null;
  startedAt: Date | null;
  attempt?: number;
}): Promise<void> => {
  await db.OrchestrationNodeExecution.create({
    runId: args.runRecord.id as number,
    nodeId: args.nodeId,
    nodeType: args.nodeType,
    attempt: args.attempt ?? 1,
    status: args.status,
    input: args.input,
    output: args.output,
    error: args.error,
    startedAt: args.startedAt,
    completedAt: args.status === 'skipped' ? null : new Date(),
  });
};

const summarizeNodeResult = (
  execResult: NodeExecutionResult
): {
  status: 'completed' | 'requires_action';
  output: Record<string, unknown>;
} => {
  if (execResult.kind === 'requires_action') {
    return {
      status: 'requires_action',
      output: {
        prompt: execResult.prompt,
        context: execResult.context,
        ...(execResult.options ? { options: execResult.options } : {}),
      },
    };
  }
  if (execResult.kind === 'condition') {
    return { status: 'completed', output: { label: execResult.label } };
  }
  if (execResult.kind === 'wait') {
    // A wait is never summarized into a node execution — executeAndRecordNode
    // returns before reaching here. Guard exhaustively for the type checker.
    return { status: 'completed', output: {} };
  }
  return { status: 'completed', output: execResult.artifact };
};

/**
 * Handles a node execution failure: records the failed attempt (so the per-node
 * trace shows every try), then either parks the run on a retry wait — when the
 * error is transient and attempts remain — or re-throws to fail the run. A
 * terminal error, or exhausting the attempt budget, re-throws.
 */
const handleNodeFailure = async (args: {
  error: unknown;
  nodeId: string;
  nodeDefn: OrchestrationNode | undefined;
  nodeType: string | null;
  runRecord: InstanceType<typeof db.OrchestrationRun>;
  input: Record<string, unknown> | null;
  attempt: number;
  startedAt: Date;
  // The keyed `running` row reserved before dispatch (side-effecting nodes),
  // updated in place to `failed` instead of writing a second record.
  keyedRow?: ReservedRow;
}): Promise<{
  nodeId: string;
  nodeDefn: OrchestrationNode;
  execResult: NodeExecutionResult;
}> => {
  const { error, nodeId, nodeDefn, nodeType, runRecord, input, attempt } = args;
  if (args.keyedRow) {
    await args.keyedRow.update({
      status: 'failed',
      error: buildRunError(error),
      completedAt: new Date(),
    });
  } else {
    await recordNodeExecution({
      runRecord,
      nodeId,
      nodeType,
      attempt,
      status: 'failed',
      input,
      output: null,
      error: buildRunError(error),
      startedAt: args.startedAt,
    });
  }

  if (nodeDefn) {
    const policy = resolveRetryPolicy(nodeDefn);
    if (isRetriableError(error) && attempt < policy.maxAttempts) {
      log(
        'handleNodeFailure: retrying node=%s attempt=%d/%d',
        nodeId,
        attempt,
        policy.maxAttempts
      );
      return {
        nodeId,
        nodeDefn,
        execResult: {
          kind: 'wait',
          nodeId,
          resumeInMs: backoffMs({ policy, attempt }),
          resume: { kind: 'retry', attempt: attempt + 1 },
        },
      };
    }
  }
  throw error;
};

/**
 * Records a successful (or requires_action) node result: updates the keyed
 * `running` row in place for a side-effecting node, or writes a fresh record
 * for a pure node.
 */
const recordNodeSuccess = async (args: {
  keyedRow: ReservedRow | undefined;
  runRecord: InstanceType<typeof db.OrchestrationRun>;
  nodeId: string;
  nodeType: string | null;
  attempt: number;
  input: Record<string, unknown> | null;
  startedAt: Date;
  status: 'completed' | 'requires_action';
  output: Record<string, unknown>;
}): Promise<void> => {
  if (args.keyedRow) {
    await args.keyedRow.update({
      status: args.status,
      output: args.output,
      error: null,
      completedAt: new Date(),
    });
    return;
  }
  await recordNodeExecution({
    runRecord: args.runRecord,
    nodeId: args.nodeId,
    nodeType: args.nodeType,
    attempt: args.attempt,
    status: args.status,
    input: args.input,
    output: args.output,
    error: null,
    startedAt: args.startedAt,
  });
};

type ExecutionContext = {
  nodeId: string;
  runRecord: InstanceType<typeof db.OrchestrationRun>;
  nodes: OrchestrationNode[];
  state: Record<string, unknown>;
  projectIds: number[];
  traceId: string | null;
  authHeader?: string;
  pollAttempt?: number;
  nodeType: string | null;
  attempt: number;
  input: Record<string, unknown> | null;
  startedAt: Date;
  idempotencyKey: string | null;
};

/**
 * Dispatches the node and records its (non-failing) outcome: a `wait` returns
 * without recording (the reserved keyed row, if any, is dropped); otherwise the
 * completed/requires_action result is persisted (keyed row updated in place, or
 * a fresh record for a pure node).
 */
const runNodeAndRecord = async (
  ctx: ExecutionContext,
  keyedRow: ReservedRow | undefined
): Promise<NodeOutcome> => {
  const result = await executeNodeById({
    nodeId: ctx.nodeId,
    nodes: ctx.nodes,
    state: ctx.state,
    projectIds: ctx.projectIds,
    projectId: ctx.runRecord.projectId as number,
    runPublicId: ctx.runRecord.publicId as string,
    triggerId: ctx.runRecord.triggerId ?? undefined,
    traceId: ctx.traceId,
    authHeader: ctx.authHeader,
    pollAttempt: ctx.pollAttempt,
    idempotencyKey: ctx.idempotencyKey ?? undefined,
  });
  // A `wait` result means the node has not finished — it will be resumed by the
  // scheduler; record nothing yet. (Keyed side-effecting nodes never `wait`.)
  if (result.execResult.kind === 'wait') {
    if (keyedRow) await keyedRow.destroy();
    return result;
  }
  const { status, output } = summarizeNodeResult(result.execResult);
  await recordNodeSuccess({
    keyedRow,
    runRecord: ctx.runRecord,
    nodeId: ctx.nodeId,
    nodeType: ctx.nodeType,
    attempt: ctx.attempt,
    input: ctx.input,
    startedAt: ctx.startedAt,
    status,
    output,
  });
  return result;
};

/**
 * Executes a single node and persists an OrchestrationNodeExecution record
 * capturing its resolved input, output, status, and (on failure) error. For a
 * side-effecting node the record is keyed for run-scoped idempotency (D5): a
 * `running` row is written before dispatch and a completed key short-circuits a
 * redelivered execution. The record is written before re-throwing so a failing
 * node is always traceable via get-orchestration-run.
 */
export const executeAndRecordNode = async (args: {
  nodeId: string;
  runRecord: InstanceType<typeof db.OrchestrationRun>;
  nodes: OrchestrationNode[];
  state: Record<string, unknown>;
  projectIds: number[];
  traceId: string | null;
  authHeader?: string;
  pollAttempt?: number;
  retryAttempt?: number;
}): Promise<NodeOutcome> => {
  const { nodeId, runRecord, nodes, state } = args;
  const nodeDefn = nodes.find((n) => {
    return n.id === nodeId;
  });
  const nodeType = nodeDefn?.type ?? null;
  const attempt = Math.max(args.retryAttempt ?? 1, 1);
  const ctx: ExecutionContext = {
    nodeId,
    runRecord,
    nodes,
    state,
    projectIds: args.projectIds,
    traceId: args.traceId,
    authHeader: args.authHeader,
    pollAttempt: args.pollAttempt,
    nodeType,
    attempt,
    input: applyInputMapping(nodeDefn?.inputMapping, state),
    startedAt: new Date(),
    idempotencyKey: computeNodeIdempotencyKey({
      runPublicId: runRecord.publicId as string,
      nodeId,
      nodeType,
      attempt,
    }),
  };

  const prepared = await prepareKeyedExecution({
    idempotencyKey: ctx.idempotencyKey,
    nodeDefn,
    nodeId,
    nodeType,
    attempt,
    input: ctx.input,
    runRecord,
    startedAt: ctx.startedAt,
  });
  if (prepared.reuse) return prepared.reuse;

  try {
    return await runNodeAndRecord(ctx, prepared.keyedRow);
  } catch (error: unknown) {
    return handleNodeFailure({
      error,
      nodeId,
      nodeDefn,
      nodeType,
      runRecord,
      input: ctx.input,
      attempt,
      startedAt: ctx.startedAt,
      keyedRow: prepared.keyedRow,
    });
  }
};

/**
 * Records the completed node execution for a delay node once its timer has
 * elapsed. The delay's execution is not recorded when it first pauses (it
 * returns a `wait`), so this fills in the record on resumption to keep the
 * per-node trace complete.
 */
export const recordDelayResumption = async (args: {
  runRecord: InstanceType<typeof db.OrchestrationRun>;
  node: OrchestrationNode;
  state: Record<string, unknown>;
  artifact: Record<string, unknown>;
}): Promise<void> => {
  await recordNodeExecution({
    runRecord: args.runRecord,
    nodeId: args.node.id,
    nodeType: args.node.type,
    status: 'completed',
    input: applyInputMapping(args.node.inputMapping, args.state),
    output: args.artifact,
    error: null,
    startedAt: new Date(),
  });
};

/**
 * Finalizes a human/webhook-receive node's own `node_executions` entry once
 * its pause is satisfied. The node's record is written as `requires_action`
 * when the run first pauses (see `summarizeNodeResult`); without this, that
 * record is never revisited and the finished run's history keeps claiming the
 * node is still waiting on an action, even though the submitted payload was
 * already applied to `state`/`artifacts` by `applyHumanInputToState`.
 */
export const recordHumanInputResumption = async (args: {
  runRecord: InstanceType<typeof db.OrchestrationRun>;
  humanNodeId: string;
  humanOutput: Record<string, unknown>;
}): Promise<void> => {
  const { runRecord, humanNodeId, humanOutput } = args;
  await db.OrchestrationNodeExecution.update(
    { status: 'completed', output: humanOutput, completedAt: new Date() },
    {
      where: {
        runId: runRecord.id as number,
        nodeId: humanNodeId,
        status: 'requires_action',
      },
    }
  );
};

export const recordSkippedNodeExecutions = async (args: {
  runRecord: InstanceType<typeof db.OrchestrationRun>;
  nodes: OrchestrationNode[];
}): Promise<void> => {
  const executed = await db.OrchestrationNodeExecution.findAll({
    where: { runId: args.runRecord.id as number },
    attributes: ['nodeId'],
  });
  const executedIds = new Set(
    executed.map((e) => {
      return e.nodeId;
    })
  );
  const skipped = args.nodes.filter((n) => {
    return !executedIds.has(n.id);
  });
  await Promise.all(
    skipped.map((n) => {
      return recordNodeExecution({
        runRecord: args.runRecord,
        nodeId: n.id,
        nodeType: n.type,
        status: 'skipped',
        input: null,
        output: null,
        error: null,
        startedAt: null,
      });
    })
  );
};
