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
  traceId: string | null;
  authHeader?: string;
  // 1-based attempt number for a resuming poll node; undefined for a first run.
  pollAttempt?: number;
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
    traceId,
    authHeader,
    pollAttempt,
    idempotencyKey,
  } = args;
  const simple = dispatchSimpleNode(args);
  if (simple !== null) return simple;
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
      });
    case 'poll':
      return executePollNode({
        node: nodeDefn,
        state,
        projectIds,
        authHeader,
        attempt: pollAttempt,
      });
    case 'knowledge':
      return executeKnowledgeNode({ node: nodeDefn, state, projectIds });
    case 'memory_write':
      return executeMemoryWriteNode({ node: nodeDefn, state });
    case 'loop':
      return executeLoopNode({
        node: nodeDefn,
        state,
        projectIds,
        traceId,
        authHeader,
      });
    case 'sub_orchestration':
      return executeSubOrchestrationNode({
        node: nodeDefn,
        state,
        projectIds,
        traceId,
        authHeader,
      });
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
  traceId: string | null;
  authHeader?: string;
  pollAttempt?: number;
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
    traceId,
    authHeader,
    pollAttempt,
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
    traceId,
    authHeader,
    pollAttempt,
    idempotencyKey,
  });
  return { nodeId, nodeDefn, execResult };
};
