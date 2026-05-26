import jsonLogic from 'json-logic-js';

import { db } from '../db';
import { DomainError } from '../errors';
import { createGeneration } from './agentGeneration';
import { searchKnowledge } from './knowledge';
import { writeMemoryEntry } from './memoryEntries';
import { resolveNextNodes } from './orchestrationGraph';
import type { OrchestrationEdge, OrchestrationNode } from './orchestrations';
import { callTool } from './tools';

export {
  detectCycle,
  findStartNodes,
  resolveNextNodes,
} from './orchestrationGraph';

// ── Types ─────────────────────────────────────────────────────────────────

export type NodeExecutionResult =
  | { kind: 'artifact'; artifact: Record<string, unknown> }
  | { kind: 'condition'; label: string }
  | {
      kind: 'requires_action';
      nodeId: string;
      prompt: string;
      context: Record<string, unknown>;
      options?: string[];
    };

export type RequiredAction = {
  nodeId: string;
  prompt: string;
  context: Record<string, unknown>;
  options?: string[];
};

// ── State utilities ───────────────────────────────────────────────────────

const resolveFromState = (
  path: string,
  state: Record<string, unknown>
): unknown => {
  if (!path.startsWith('state.')) return undefined;
  const parts = path.slice('state.'.length).split('.');
  let cursor: unknown = state;
  for (const part of parts) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
};

const writeToState = (
  path: string,
  value: unknown,
  state: Record<string, unknown>
): void => {
  if (!path.startsWith('state.')) return;
  const fieldName = path.slice('state.'.length);
  state[fieldName] = value;
};

export const applyInputMapping = (
  inputMapping: Record<string, string> | undefined,
  state: Record<string, unknown>
): Record<string, unknown> => {
  if (!inputMapping) return {};
  const result: Record<string, unknown> = {};
  for (const [key, path] of Object.entries(inputMapping)) {
    result[key] = resolveFromState(path, state);
  }
  return result;
};

export const applyOutputMapping = (
  outputMapping: Record<string, string> | undefined,
  artifact: Record<string, unknown>,
  state: Record<string, unknown>
): void => {
  if (!outputMapping) return;
  for (const [artifactKey, statePath] of Object.entries(outputMapping)) {
    writeToState(statePath, artifact[artifactKey], state);
  }
};

// ── Node executors ────────────────────────────────────────────────────────

const parseAgentOutput = (
  content: unknown,
  outputSchema: object | undefined
): Record<string, unknown> => {
  if (!outputSchema || typeof content !== 'string') {
    return { content: content ?? null };
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // leave artifact as { content }
  }
  return { content };
};

const executeAgentNode = async (args: {
  node: OrchestrationNode;
  state: Record<string, unknown>;
  projectIds: number[];
  traceId: string | null;
  authHeader?: string;
}): Promise<NodeExecutionResult> => {
  const { node, state, projectIds, traceId, authHeader } = args;
  if (!node.agentId)
    throw new DomainError(
      'ORCHESTRATION_NODE_FAILED',
      `Agent node '${node.id}' missing agentId.`
    );

  const inputs = applyInputMapping(node.inputMapping, state);
  const contextLines = Object.entries(inputs)
    .map(([k, v]) => {
      return `${k}: ${JSON.stringify(v)}`;
    })
    .join('\n');
  const messages: Array<{ role: string; content: string }> = [
    { role: 'user', content: contextLines || '(no input)' },
  ];

  const result = await createGeneration({
    projectIds,
    agentId: node.agentId,
    messages,
    parentTraceId: traceId,
    authHeader,
  });

  if (result instanceof ReadableStream) {
    throw new DomainError(
      'ORCHESTRATION_NODE_FAILED',
      `Agent node '${node.id}' returned a streaming response, which is not supported in orchestrations.`
    );
  }

  const artifact = parseAgentOutput(result.output?.content, node.outputSchema);
  return { kind: 'artifact', artifact };
};

const executeToolNode = async (args: {
  node: OrchestrationNode;
  state: Record<string, unknown>;
  projectIds: number[];
  authHeader?: string;
}): Promise<NodeExecutionResult> => {
  const { node, state, projectIds, authHeader } = args;
  if (!node.toolId)
    throw new DomainError(
      'ORCHESTRATION_NODE_FAILED',
      `Tool node '${node.id}' missing toolId.`
    );

  const inputs = applyInputMapping(node.inputMapping, state);
  const result = await callTool({
    projectIds,
    id: node.toolId,
    action: node.operationId,
    input: inputs as Record<string, unknown>,
    authHeader,
  });

  const artifact: Record<string, unknown> =
    typeof result === 'object' && result !== null
      ? (result as Record<string, unknown>)
      : { result };

  return { kind: 'artifact', artifact };
};

const executeTransformNode = (args: {
  node: OrchestrationNode;
  state: Record<string, unknown>;
}): NodeExecutionResult => {
  const { node, state } = args;
  if (node.expression === undefined || node.expression === null)
    throw new DomainError(
      'ORCHESTRATION_NODE_FAILED',
      `Transform node '${node.id}' missing expression.`
    );

  const result: unknown = jsonLogic.apply(
    node.expression as Parameters<typeof jsonLogic.apply>[0],
    state
  );
  return { kind: 'artifact', artifact: { result } };
};

const executeKnowledgeNode = async (args: {
  node: OrchestrationNode;
  state: Record<string, unknown>;
  projectIds: number[];
}): Promise<NodeExecutionResult> => {
  const { node, state, projectIds } = args;
  const inputs = applyInputMapping(node.inputMapping, state);

  const results = await searchKnowledge({
    projectIds,
    query: typeof inputs['query'] === 'string' ? inputs['query'] : undefined,
    memoryIds: Array.isArray(inputs['memoryIds'])
      ? (inputs['memoryIds'] as string[])
      : undefined,
    memoryTags: Array.isArray(inputs['memoryTags'])
      ? (inputs['memoryTags'] as string[])
      : undefined,
  });

  return { kind: 'artifact', artifact: { results } };
};

const executeMemoryWriteNode = async (args: {
  node: OrchestrationNode;
  state: Record<string, unknown>;
}): Promise<NodeExecutionResult> => {
  const { node, state } = args;
  if (!node.memoryId)
    throw new DomainError(
      'ORCHESTRATION_NODE_FAILED',
      `memory_write node '${node.id}' missing memoryId.`
    );

  const inputs = applyInputMapping(node.inputMapping, state);
  const memory = await db.Memory.findOne({
    where: { publicId: node.memoryId },
  });
  if (!memory)
    throw new DomainError(
      'ORCHESTRATION_NODE_FAILED',
      `Memory '${node.memoryId}' not found.`
    );

  const content =
    typeof inputs['content'] === 'string'
      ? inputs['content']
      : JSON.stringify(inputs['content'] ?? '');

  const writeResult = await writeMemoryEntry({
    memoryId: memory.id as number,
    content,
  });

  return { kind: 'artifact', artifact: { action: writeResult.action } };
};

const executeConditionNode = (args: {
  node: OrchestrationNode;
  state: Record<string, unknown>;
}): NodeExecutionResult => {
  const { node, state } = args;
  if (node.expression === undefined || node.expression === null)
    throw new DomainError(
      'ORCHESTRATION_NODE_FAILED',
      `Condition node '${node.id}' missing expression.`
    );

  const label = String(
    jsonLogic.apply(
      node.expression as Parameters<typeof jsonLogic.apply>[0],
      state
    )
  );
  return { kind: 'condition', label };
};

const executeHumanNode = (args: {
  node: OrchestrationNode;
  state: Record<string, unknown>;
}): NodeExecutionResult => {
  const { node, state } = args;
  const context = applyInputMapping(node.inputMapping, state);
  return {
    kind: 'requires_action',
    nodeId: node.id,
    prompt: node.prompt ?? 'Human input required.',
    context,
    options: node.options,
  };
};

const parseIsoDuration = (duration: string): number => {
  // Support PT<n>S, PT<n>M, PT<n>H, P<n>D patterns
  const match =
    /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
      duration
    );
  if (!match) return 0;
  const days = parseFloat(match[1] ?? '0');
  const hours = parseFloat(match[2] ?? '0');
  const minutes = parseFloat(match[3] ?? '0');
  const seconds = parseFloat(match[4] ?? '0');
  return ((days * 24 + hours) * 60 + minutes) * 60000 + seconds * 1000;
};

const executeDelayNode = async (args: {
  node: OrchestrationNode;
}): Promise<NodeExecutionResult> => {
  const { node } = args;
  if (!node.duration)
    throw new DomainError(
      'ORCHESTRATION_NODE_FAILED',
      `Delay node '${node.id}' missing duration.`
    );
  const ms = parseIsoDuration(node.duration);
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
  return { kind: 'artifact', artifact: { waited: node.duration } };
};

const executeWebhookNode = (args: {
  node: OrchestrationNode;
  state: Record<string, unknown>;
}): NodeExecutionResult => {
  const { node, state } = args;
  const mode = node.mode ?? 'emit';
  if (mode === 'receive') {
    const context = applyInputMapping(node.inputMapping, state);
    return {
      kind: 'requires_action',
      nodeId: node.id,
      prompt: 'Waiting for webhook callback.',
      context,
    };
  }
  // emit mode: fire-and-forget POST (best-effort, non-blocking)
  if (node.webhookUrl) {
    const payload = applyInputMapping(node.inputMapping, state);
    // Fire without awaiting — failures are best-effort
    fetch(node.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {
      /* best-effort */
    });
  }
  return { kind: 'artifact', artifact: { emitted: true } };
};

const executeLoopNode = async (args: {
  node: OrchestrationNode;
  state: Record<string, unknown>;
  projectIds: number[];
  traceId: string | null;
  authHeader?: string;
}): Promise<NodeExecutionResult> => {
  const { node, state, projectIds, authHeader } = args;
  if (!node.subGraph)
    throw new DomainError(
      'ORCHESTRATION_NODE_FAILED',
      `Loop node '${node.id}' missing subGraph.`
    );

  const collectionPath = node.collection ?? 'state.items';
  const itemVariable = node.itemVariable ?? 'item';
  const parallelism = node.parallelism ?? 5;

  const collection = resolveFromState(
    collectionPath.startsWith('state.')
      ? collectionPath
      : `state.${collectionPath}`,
    state
  );
  const items: unknown[] = Array.isArray(collection) ? collection : [];

  const { startOrchestrationRun } = await import('./orchestrationEngine');

  const results: unknown[] = [];
  // Process in batches of `parallelism`
  for (let i = 0; i < items.length; i += parallelism) {
    const batch = items.slice(i, i + parallelism);
    const batchResults = await Promise.all(
      batch.map((item) => {
        const itemInput: Record<string, unknown> = { [itemVariable]: item };
        return startOrchestrationRun({
          orchestrationPublicId: node.subGraph as string,
          projectId: projectIds[0],
          projectIds,
          input: itemInput,
          authHeader,
        });
      })
    );
    results.push(...batchResults.map((r) => r.output));
  }

  return { kind: 'artifact', artifact: { results } };
};

const executeSubOrchestrationNode = async (args: {
  node: OrchestrationNode;
  state: Record<string, unknown>;
  projectIds: number[];
  traceId: string | null;
  authHeader?: string;
}): Promise<NodeExecutionResult> => {
  const { node, state, projectIds, authHeader } = args;
  if (!node.orchestrationId)
    throw new DomainError(
      'ORCHESTRATION_NODE_FAILED',
      `sub_orchestration node '${node.id}' missing orchestrationId.`
    );

  const input = applyInputMapping(node.inputMapping, state);
  const { startOrchestrationRun } = await import('./orchestrationEngine');
  const run = await startOrchestrationRun({
    orchestrationPublicId: node.orchestrationId,
    projectId: projectIds[0],
    projectIds,
    input,
    authHeader,
  });

  return { kind: 'artifact', artifact: run.output ?? {} };
};

// ── Dispatch ──────────────────────────────────────────────────────────────

export const executeNodeById = async (args: {
  nodeId: string;
  nodes: OrchestrationNode[];
  state: Record<string, unknown>;
  projectIds: number[];
  traceId: string | null;
  authHeader?: string;
}): Promise<{
  nodeId: string;
  nodeDefn: OrchestrationNode;
  execResult: NodeExecutionResult;
}> => {
  const { nodeId, nodes, state, projectIds, traceId, authHeader } = args;

  const nodeDefn = nodes.find((n) => {
    return n.id === nodeId;
  });
  if (!nodeDefn) {
    throw new DomainError(
      'ORCHESTRATION_NODE_FAILED',
      `Node '${nodeId}' not found in orchestration definition.`
    );
  }

  let execResult: NodeExecutionResult;

  switch (nodeDefn.type) {
    case 'agent':
      execResult = await executeAgentNode({
        node: nodeDefn,
        state,
        projectIds,
        traceId,
        authHeader,
      });
      break;
    case 'tool':
      execResult = await executeToolNode({
        node: nodeDefn,
        state,
        projectIds,
        authHeader,
      });
      break;
    case 'transform':
      execResult = executeTransformNode({ node: nodeDefn, state });
      break;
    case 'knowledge':
      execResult = await executeKnowledgeNode({
        node: nodeDefn,
        state,
        projectIds,
      });
      break;
    case 'memory_write':
      execResult = await executeMemoryWriteNode({ node: nodeDefn, state });
      break;
    case 'condition':
      execResult = executeConditionNode({ node: nodeDefn, state });
      break;
    case 'human':
      execResult = executeHumanNode({ node: nodeDefn, state });
      break;
    case 'delay':
      execResult = await executeDelayNode({ node: nodeDefn });
      break;
    case 'webhook':
      execResult = executeWebhookNode({ node: nodeDefn, state });
      break;
    case 'loop':
      execResult = await executeLoopNode({
        node: nodeDefn,
        state,
        projectIds,
        traceId,
        authHeader,
      });
      break;
    case 'sub_orchestration':
      execResult = await executeSubOrchestrationNode({
        node: nodeDefn,
        state,
        projectIds,
        traceId,
        authHeader,
      });
      break;
    default:
      throw new DomainError(
        'ORCHESTRATION_NODE_FAILED',
        `Unknown node type '${(nodeDefn as OrchestrationNode).type}'.`
      );
  }

  return { nodeId, nodeDefn, execResult };
};

// ── Batch result processing ───────────────────────────────────────────────

export const processNodeResultBatch = (args: {
  nodeResults: Array<{
    nodeId: string;
    nodeDefn: OrchestrationNode;
    execResult: NodeExecutionResult;
  }>;
  artifacts: Record<string, unknown>;
  conditionLabels: Map<string, string>;
  completedNodes: Set<string>;
  activatedNodes: Set<string>;
  state: Record<string, unknown>;
  edges: OrchestrationEdge[];
  isRunning: boolean;
}): { nextRound: string[]; requiredAction: RequiredAction | null } => {
  const {
    nodeResults,
    artifacts,
    conditionLabels,
    completedNodes,
    activatedNodes,
    state,
    edges,
    isRunning,
  } = args;

  const nextRound: string[] = [];
  let requiredAction: RequiredAction | null = null;

  for (const { nodeId, nodeDefn, execResult } of nodeResults) {
    if (execResult.kind === 'requires_action') {
      if (!requiredAction) {
        requiredAction = {
          nodeId: execResult.nodeId,
          prompt: execResult.prompt,
          context: execResult.context,
          options: execResult.options,
        };
      }
      continue;
    }

    if (execResult.kind === 'condition') {
      conditionLabels.set(nodeId, execResult.label);
    } else {
      artifacts[nodeId] = execResult.artifact;
      applyOutputMapping(nodeDefn.outputMapping, execResult.artifact, state);
    }

    completedNodes.add(nodeId);

    if (isRunning && !requiredAction) {
      const resolved = resolveNextNodes({
        completedNodeId: nodeId,
        completedNodes,
        conditionLabels,
        edges,
      });
      for (const n of resolved) {
        if (!activatedNodes.has(n)) {
          activatedNodes.add(n);
          nextRound.push(n);
        }
      }
    }
  }

  return { nextRound, requiredAction };
};
