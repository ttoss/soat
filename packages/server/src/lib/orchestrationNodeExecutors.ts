import { db } from '../db';
import { DomainError } from '../errors';
import { createGeneration } from './agentGeneration';
import { applyInputMapping, evaluateLogic } from './jsonLogicMapping';
import { searchKnowledge } from './knowledge';
import { writeMemoryEntry } from './memoryEntries';
import type { ApprovalNodeSpec } from './orchestrationApprovalNode';
import { parseDuration } from './orchestrationDuration';
import { startOrchestrationRun } from './orchestrationEngine';
import { parseMemoryWriteInputs } from './orchestrationMemoryWrite';
import type { OrchestrationNode } from './orchestrations';
import { callTool } from './tools';

/**
 * Describes how a scheduled `wait` should be resumed once its timer elapses.
 * `delay` carries the artifact the delay node produces (the wait is a pure
 * timer, so on resume the node is simply recorded as complete). `poll` carries
 * the next attempt number, so the poll node re-executes from where it left off.
 */
export type WaitResume =
  | { kind: 'delay'; artifact: Record<string, unknown> }
  | { kind: 'poll'; attempt: number }
  | { kind: 'retry'; attempt: number };

export type NodeExecutionResult =
  | { kind: 'artifact'; artifact: Record<string, unknown>; traceId?: string }
  | { kind: 'condition'; label: string }
  | {
      kind: 'requires_action';
      type: 'human_input' | 'webhook_receive' | 'approval';
      nodeId: string;
      prompt: string;
      context: Record<string, unknown>;
      options?: string[];
      // Present only for `approval` requires_action: the frozen proposal the
      // engine emits as an ApprovalItem when the run parks (§5b of the PRD).
      approvalSpec?: ApprovalNodeSpec;
    }
  | {
      // The node cannot complete now and must be resumed after `resumeInMs`.
      // Used by `delay` (a timer) and `poll` (the wait between attempts) so
      // long waits are offloaded to the background scheduler instead of holding
      // the run loop — and its HTTP request — open.
      kind: 'wait';
      nodeId: string;
      resumeInMs: number;
      resume: WaitResume;
    };

const writeToState = (
  path: string,
  value: unknown,
  state: Record<string, unknown>
): void => {
  const normalizedPath = path.startsWith('state.') ? path : `state.${path}`;
  const fieldName = normalizedPath.slice('state.'.length);
  // A dotted target (`state.proposed.action_id`) must build a nested object so
  // it can later be read back with `{ "var": "proposed.action_id" }` — the
  // JSON-Logic `var` reader descends dot-paths. Writing the whole dotted string
  // as a single flat key (the previous behavior) left `{ "var": "a.b" }`
  // resolving to null, since `var` looks for `state.a.b`, not `state["a.b"]`.
  // The nested read path (`resolveLoopCollection`) already assumed this shape.
  const segments = fieldName.split('.');
  let cursor = state;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i] as string;
    const next = cursor[segment];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1] as string] = value;
};

// `applyInputMapping` and the JSON Logic evaluator now live in
// `./jsonLogicMapping` so orchestration nodes and pipeline tools share a single
// evaluator. Re-exported here to preserve the existing import surface.
export { applyInputMapping };

/**
 * Projects a completed node's artifact into run state: each key of
 * `stateMapping` is a state write path, and each value is JSON Logic
 * evaluated against `{ output: artifact, state }` — e.g.
 * `{ "summary": { "var": "output.content" } }` writes the artifact's
 * `content` field to `state.summary`. One evaluator, one mental model, shared
 * with `input_mapping`/`transform`/`condition` (only the context differs).
 */
export const applyStateMapping = (
  stateMapping: Record<string, unknown> | undefined,
  artifact: Record<string, unknown>,
  state: Record<string, unknown>
): void => {
  if (!stateMapping) return;
  const context = { output: artifact, state };
  for (const [statePath, expr] of Object.entries(stateMapping)) {
    // Clone before writing: the evaluator returns references, so an
    // expression like { "var": "state" } (or { "var": "" }) resolves to the
    // live state object — writing it back uncloned would nest state inside
    // itself and crash JSON serialization at the next checkpoint/response.
    // Same hazard writeNodeArtifact guards against for the nodes namespace.
    writeToState(
      statePath,
      structuredClone(evaluateLogic(expr, context)),
      state
    );
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
  // Orchestration attribution: the public run id that owns this node execution
  // and the trigger firing (if any) that started the run. Both are stamped onto
  // the generation's usage event so spend rolls up per run, per node, and per
  // trigger.
  runPublicId?: string;
  triggerId?: string;
}): Promise<NodeExecutionResult> => {
  const {
    node,
    state,
    projectIds,
    traceId,
    authHeader,
    runPublicId,
    triggerId,
  } = args;
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
    runId: runPublicId,
    nodeId: node.id,
    triggerId,
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

  const writeResult = await writeMemoryEntry({
    memoryId: memory.id as number,
    ...parseMemoryWriteInputs(inputs),
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

export const executeDelayNode = (args: {
  node: OrchestrationNode;
}): NodeExecutionResult => {
  const { node } = args;
  if (!node.duration)
    throw new DomainError(
      'ORCHESTRATION_NODE_FAILED',
      `Delay node '${node.id}' missing duration.`
    );
  const ms = parseDuration(node.duration);
  const artifact = { waited: node.duration };
  // A zero-length delay completes immediately; anything longer is offloaded to
  // the scheduler as a durable wait rather than blocking the run loop.
  if (ms <= 0) {
    return { kind: 'artifact', artifact };
  }
  return {
    kind: 'wait',
    nodeId: node.id,
    resumeInMs: ms,
    resume: { kind: 'delay', artifact },
  };
};

export { executeEmitEventNode } from './orchestrationEmitEventNode';
export { executeWebhookNode } from './orchestrationWebhookNode';

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
    // A sub-orchestration is a synchronous child: its terminal output feeds this
    // node's artifact, so it must run to completion before continuing.
    wait: true,
  });

  return { kind: 'artifact', artifact: run.output ?? {} };
};
