import { db } from '../db';
import { DomainError } from '../errors';
import { createGeneration } from './agentGeneration';
import { applyInputMapping, evaluateLogic } from './jsonLogicMapping';
import { searchKnowledge } from './knowledge';
import { writeMemoryEntry } from './memoryEntries';
import { startOrchestrationRun } from './orchestrationEngine';
import type { OrchestrationNode } from './orchestrations';
import { callTool } from './tools';

export type NodeExecutionResult =
  | { kind: 'artifact'; artifact: Record<string, unknown>; traceId?: string }
  | { kind: 'condition'; label: string }
  | {
      kind: 'requires_action';
      type: 'human_input' | 'webhook_receive';
      nodeId: string;
      prompt: string;
      context: Record<string, unknown>;
      options?: string[];
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

// `applyInputMapping` and the JSON Logic evaluator now live in
// `./jsonLogicMapping` so orchestration nodes and pipeline tools share a single
// evaluator. Re-exported here to preserve the existing import surface.
export { applyInputMapping };

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
  return { kind: 'artifact', artifact, traceId: result.traceId };
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

  const result = evaluateLogic(node.expression, state);
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

  const label = String(evaluateLogic(node.expression, state));
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
    type: 'human_input',
    nodeId: node.id,
    prompt: node.prompt ?? 'Human input required.',
    context,
    options: node.options,
  };
};

const SUFFIX_UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60000,
  h: 3600000,
  d: 86400000,
};

/**
 * Parses a duration string to milliseconds. Accepts a friendly suffix form
 * (`5s`, `30s`, `5m`, `2h`, `1d`, `500ms`) or ISO 8601 (`PT5S`, `PT1M30S`,
 * `P1DT2H`). Unparseable input resolves to `0` (a no-op wait), matching the
 * delay node's long-standing behaviour. Shared by the `delay` and `poll` nodes
 * so both accept the same formats.
 */
export const parseDuration = (value: string): number => {
  const suffix = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value.trim());
  if (suffix) {
    const amount = parseFloat(suffix[1] ?? '0');
    const unitMs = SUFFIX_UNIT_MS[suffix[2] ?? 's'] ?? 1000;
    return amount * unitMs;
  }
  const iso =
    /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
      value
    );
  if (!iso) return 0;
  const days = parseFloat(iso[1] ?? '0');
  const hours = parseFloat(iso[2] ?? '0');
  const minutes = parseFloat(iso[3] ?? '0');
  const seconds = parseFloat(iso[4] ?? '0');
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
  const ms = parseDuration(node.duration);
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
      type: 'webhook_receive',
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
  orchestrationId: string;
  projectIds: number[];
  authHeader?: string;
}): Promise<unknown[]> => {
  const {
    items,
    parallelism,
    itemVariable,
    orchestrationId,
    projectIds,
    authHeader,
  } = args;
  const results: unknown[] = [];
  for (let i = 0; i < items.length; i += parallelism) {
    const batch = items.slice(i, i + parallelism);
    const batchResults = await Promise.all(
      batch.map((item) => {
        const itemInput: Record<string, unknown> = { [itemVariable]: item };
        return startOrchestrationRun({
          orchestrationPublicId: orchestrationId,
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
  if (!node.orchestrationId)
    throw new DomainError(
      'ORCHESTRATION_NODE_FAILED',
      `Loop node '${node.id}' missing orchestrationId.`
    );

  const collectionPath = node.collection ?? 'state.items';
  const itemVariable = node.itemVariable ?? 'item';
  const parallelism = node.parallelism ?? 5;
  const items = resolveLoopCollection({ collectionPath, state });
  const results = await runLoopBatches({
    items,
    parallelism,
    itemVariable,
    orchestrationId: node.orchestrationId,
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
  const run = await startOrchestrationRun({
    orchestrationPublicId: node.orchestrationId,
    projectId: projectIds[0],
    projectIds,
    input,
    authHeader,
  });

  return { kind: 'artifact', artifact: run.output ?? {} };
};
