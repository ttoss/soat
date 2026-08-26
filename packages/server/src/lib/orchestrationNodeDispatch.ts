import { DomainError } from '../errors';
import { executeApprovalNode } from './orchestrationApprovalNode';
import { executeEmitEventNode } from './orchestrationEmitEventNode';
import {
  executeAgentNode,
  executeConditionNode,
  executeDelayNode,
  executeHumanNode,
  executeKnowledgeNode,
  executeLoopNode,
  executeMemoryWriteNode,
  executeSubOrchestrationNode,
  executeToolNode,
  executeTransformNode,
} from './orchestrationNodeExecutors';
import type { NodeExecutionResult } from './orchestrationNodeTypes';
import { executePollNode } from './orchestrationPollNode';
import type { OrchestrationNode } from './orchestrations';
import { executeWebhookNode } from './orchestrationWebhookNode';

/**
 * Node type → executor. This module dispatches; it executes nothing itself.
 *
 * It and `orchestrationBatchResults.ts` were one file called
 * `orchestrationExecutors.ts`, which executed nothing either and re-exported a
 * third module's graph helpers on top — a name and a boundary that told a
 * reader nothing about which of the two "executors" modules they wanted
 * (#910). Importers now name the seam they actually depend on.
 */

type DispatchArgs = {
  nodeDefn: OrchestrationNode;
  state: Record<string, unknown>;
  projectIds: number[];
  // The run's own project id — used for project-scoped resolution (secrets) and
  // to scope an emit_event node's event to the run's project.
  projectId?: number;
  // The run's public id — used as the resourceId of an emit_event node's event
  // and stamped onto in-run generations' usage events for per-run roll-up.
  runPublicId?: string;
  // The trigger firing (if any) that started the run — propagated onto in-run
  // generations' usage events for in-run trigger attribution.
  triggerId?: string;
  // The run's `tool_context`, forwarded to the generation an `agent` node
  // creates and inherited by the child run a `loop`/`sub_orchestration` node
  // starts.
  toolContext?: Record<string, string>;
  traceId: string | null;
  authHeader?: string;
  // 1-based attempt number for a resuming poll node; undefined for a first run.
  pollAttempt?: number;
  // The node's own 1-based retry attempt (distinct from `pollAttempt`, which
  // counts a poll node's polls). Stamped on an agent node's generation so the
  // run → generation lookup can tell one attempt's generation from another's.
  nodeAttempt?: number;
  // Run-scoped idempotency key for this node execution. Forwarded by the HTTP
  // tool executor as the `Idempotency-Key` request header (D7) so downstream
  // services can dedupe a redelivered call.
  idempotencyKey?: string;
};

const dispatchSimpleNode = (args: DispatchArgs): NodeExecutionResult | null => {
  const { nodeDefn, state } = args;
  switch (nodeDefn.type) {
    case 'transform':
      return executeTransformNode({ node: nodeDefn, state });
    case 'condition':
      return executeConditionNode({ node: nodeDefn, state });
    case 'human':
      return executeHumanNode({ node: nodeDefn, state });
    case 'approval':
      return executeApprovalNode({ node: nodeDefn, state });
    case 'delay':
      return executeDelayNode({ node: nodeDefn });
    case 'webhook':
      return executeWebhookNode({ node: nodeDefn, state });
    default:
      return null;
  }
};

/**
 * The two nodes that start a child run. They take the same inputs — differing
 * only in how many children they start and how the children's output is
 * aggregated — so they are dispatched together rather than as two cases with
 * one duplicated argument object.
 */
const dispatchNestedRunNode = (
  args: DispatchArgs
): Promise<NodeExecutionResult> | null => {
  const {
    nodeDefn,
    state,
    projectIds,
    traceId,
    authHeader,
    toolContext,
    runPublicId,
  } = args;
  if (nodeDefn.type !== 'loop' && nodeDefn.type !== 'sub_orchestration') {
    return null;
  }
  const nested = {
    node: nodeDefn,
    state,
    projectIds,
    traceId,
    authHeader,
    toolContext,
    // The parent run, so each child it starts records where it came from.
    runPublicId,
  };
  return nodeDefn.type === 'loop'
    ? executeLoopNode(nested)
    : executeSubOrchestrationNode(nested);
};

const dispatchNodeExecution = async (
  args: DispatchArgs
): Promise<NodeExecutionResult> => {
  const {
    nodeDefn,
    state,
    projectIds,
    projectId,
    runPublicId,
    triggerId,
    toolContext,
    traceId,
    authHeader,
    pollAttempt,
    nodeAttempt,
    idempotencyKey,
  } = args;
  const simple = dispatchSimpleNode(args);
  if (simple !== null) return simple;
  const nested = dispatchNestedRunNode(args);
  if (nested !== null) return nested;
  switch (nodeDefn.type) {
    case 'emit_event':
      return executeEmitEventNode({
        node: nodeDefn,
        state,
        projectId,
        runPublicId,
      });
    case 'agent':
      return executeAgentNode({
        node: nodeDefn,
        state,
        projectIds,
        traceId,
        authHeader,
        runPublicId,
        triggerId,
        nodeAttempt,
        toolContext,
      });
    case 'tool':
      return executeToolNode({
        node: nodeDefn,
        state,
        projectIds,
        projectId,
        authHeader,
        idempotencyKey,
        orchestrationRunId: runPublicId,
        toolContext,
      });
    case 'poll':
      return executePollNode({
        node: nodeDefn,
        state,
        projectIds,
        authHeader,
        attempt: pollAttempt,
        toolContext,
      });
    case 'knowledge':
      return executeKnowledgeNode({ node: nodeDefn, state, projectIds });
    case 'memory_write':
      return executeMemoryWriteNode({ node: nodeDefn, state });
    default:
      throw new DomainError(
        'ORCHESTRATION_NODE_FAILED',
        `Unknown node type '${(nodeDefn as OrchestrationNode).type}'.`
      );
  }
};

export const executeNodeById = async (args: {
  nodeId: string;
  nodes: OrchestrationNode[];
  state: Record<string, unknown>;
  projectIds: number[];
  projectId?: number;
  runPublicId?: string;
  triggerId?: string;
  toolContext?: Record<string, string>;
  traceId: string | null;
  authHeader?: string;
  pollAttempt?: number;
  nodeAttempt?: number;
  idempotencyKey?: string;
}): Promise<{
  nodeId: string;
  nodeDefn: OrchestrationNode;
  execResult: NodeExecutionResult;
}> => {
  const {
    nodeId,
    nodes,
    state,
    projectIds,
    projectId,
    runPublicId,
    triggerId,
    toolContext,
    traceId,
    authHeader,
    pollAttempt,
    nodeAttempt,
    idempotencyKey,
  } = args;
  const nodeDefn = nodes.find((n) => {
    return n.id === nodeId;
  });
  if (!nodeDefn) {
    throw new DomainError(
      'ORCHESTRATION_NODE_FAILED',
      `Node '${nodeId}' not found in orchestration definition.`
    );
  }
  const execResult = await dispatchNodeExecution({
    nodeDefn,
    state,
    projectIds,
    projectId,
    runPublicId,
    triggerId,
    toolContext,
    traceId,
    authHeader,
    pollAttempt,
    nodeAttempt,
    idempotencyKey,
  });
  return { nodeId, nodeDefn, execResult };
};
