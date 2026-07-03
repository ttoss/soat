import { db } from '../db';
import { DomainError } from '../errors';
import type { NodeExecutionResult } from './orchestrationExecutors';
import { applyInputMapping, executeNodeById } from './orchestrationExecutors';
import type { OrchestrationNode } from './orchestrations';

/**
 * Normalizes any thrown value into the structured error shape persisted on a
 * run (and on each failing node execution).
 */
export const buildRunError = (error: unknown): object => {
  return {
    message: error instanceof Error ? error.message : String(error),
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
}): Promise<void> => {
  await db.OrchestrationNodeExecution.create({
    runId: args.runRecord.id as number,
    nodeId: args.nodeId,
    nodeType: args.nodeType,
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
  const startedAt = new Date();
  try {
    const result = await executeNodeById({
      nodeId,
      nodes,
      state,
      projectIds,
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
      status,
      input,
      output,
      error: null,
      startedAt,
    });
    return result;
  } catch (error: unknown) {
    await recordNodeExecution({
      runRecord,
      nodeId,
      nodeType,
      status: 'failed',
      input,
      output: null,
      error: buildRunError(error),
      startedAt,
    });
    throw error;
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
