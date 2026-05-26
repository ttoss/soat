import jsonLogic from 'json-logic-js';

import { db } from '../db';
import { DomainError } from '../errors';
import { createGeneration } from './agentGeneration';
import { searchKnowledge } from './knowledge';
import { writeMemoryEntry } from './memoryEntries';
import type { OrchestrationNode } from './orchestrations';
import { callTool } from './tools';

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

export const executeAgentNode = async (args: {
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

export const executeToolNode = async (args: {
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

export const executeTransformNode = (args: {
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

export const executeKnowledgeNode = async (args: {
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

export const executeMemoryWriteNode = async (args: {
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

export const executeConditionNode = (args: {
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

export const executeHumanNode = (args: {
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

export const executeDelayNode = async (args: {
  node: OrchestrationNode;
}): Promise<NodeExecutionResult> => {
  const { node } = args;
  if (!node.duration)
    throw new DomainError(
      'ORCHESTRATION_NODE_FAILED',
      `Delay node '${node.id}' missing duration.`
    );
  const ms = parseIsoDuration(node.duration);
  await new Promise<void>((resolve) => {
    return setTimeout(resolve, ms);
  });
  return { kind: 'artifact', artifact: { waited: node.duration } };
};

export const executeWebhookNode = (args: {
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
  if (node.webhookUrl) {
    const payload = applyInputMapping(node.inputMapping, state);
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
  subGraph: string;
  projectIds: number[];
  authHeader?: string;
}): Promise<unknown[]> => {
  const { items, parallelism, itemVariable, subGraph, projectIds, authHeader } =
    args;
  const { startOrchestrationRun } = await import('./orchestrationEngine');
  const results: unknown[] = [];
  for (let i = 0; i < items.length; i += parallelism) {
    const batch = items.slice(i, i + parallelism);
    const batchResults = await Promise.all(
      batch.map((item) => {
        const itemInput: Record<string, unknown> = { [itemVariable]: item };
        return startOrchestrationRun({
          orchestrationPublicId: subGraph,
          projectId: projectIds[0],
          projectIds,
          input: itemInput,
          authHeader,
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
  const items = resolveLoopCollection({ collectionPath, state });
  const results = await runLoopBatches({
    items,
    parallelism,
    itemVariable,
    subGraph: node.subGraph,
    projectIds,
    authHeader,
  });

  return { kind: 'artifact', artifact: { results } };
};

export const executeSubOrchestrationNode = async (args: {
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
