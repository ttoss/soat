import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import type { NodeExecutionResult } from './orchestrationExecutors';
import { applyInputMapping, executeNodeById } from './orchestrationExecutors';
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
  status: 'completed' | 'failed' | 'requires_action' | 'skipped';
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
}): Promise<{
  nodeId: string;
  nodeDefn: OrchestrationNode;
  execResult: NodeExecutionResult;
}> => {
  const { error, nodeId, nodeDefn, nodeType, runRecord, input, attempt } = args;
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
 * Executes a single node and persists an OrchestrationNodeExecution record
 * capturing its resolved input, output, status, and (on failure) error. The
 * record is written before re-throwing so a failing node is always traceable
 * via get-orchestration-run, even though the run itself aborts.
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
}): Promise<{
  nodeId: string;
  nodeDefn: OrchestrationNode;
  execResult: NodeExecutionResult;
}> => {
  const {
    nodeId,
    runRecord,
    nodes,
    state,
    projectIds,
    traceId,
    authHeader,
    pollAttempt,
  } = args;
  const nodeDefn = nodes.find((n) => {
    return n.id === nodeId;
  });
  const nodeType = nodeDefn?.type ?? null;
  const input = applyInputMapping(nodeDefn?.inputMapping, state);
  const attempt = Math.max(args.retryAttempt ?? 1, 1);
  const startedAt = new Date();
  try {
    const result = await executeNodeById({
      nodeId,
      nodes,
      state,
      projectIds,
      projectId: runRecord.projectId as number,
      runPublicId: runRecord.publicId as string,
      triggerId: runRecord.triggerId ?? undefined,
      traceId,
      authHeader,
      pollAttempt,
    });
    // A `wait` result means the node has not finished — it will be resumed by
    // the scheduler. Do not record a node execution yet; the completed (or
    // failed) record is written when the wait resolves on a later attempt.
    if (result.execResult.kind === 'wait') {
      return result;
    }
    const { status, output } = summarizeNodeResult(result.execResult);
    await recordNodeExecution({
      runRecord,
      nodeId,
      nodeType,
      attempt,
      status,
      input,
      output,
      error: null,
      startedAt,
    });
    return result;
  } catch (error: unknown) {
    return handleNodeFailure({
      error,
      nodeId,
      nodeDefn,
      nodeType,
      runRecord,
      input,
      attempt,
      startedAt,
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
