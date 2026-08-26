import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { emitActivityEntry } from './activity';
import { createGeneration } from './agentGeneration';
import { applyInputMapping, evaluateLogic } from './jsonLogicMapping';
import { searchKnowledge } from './knowledge';
import { writeMemoryEntry } from './memoryEntries';
import { parseDuration } from './orchestrationDuration';
import { parseMemoryWriteInputs } from './orchestrationMemoryWrite';
import { type NestedRunParent, startNestedRun } from './orchestrationNestedRun';
import { requireNodeField } from './orchestrationNodeFields';
import type { NodeExecutionResult } from './orchestrationNodeTypes';
import type { OrchestrationNode } from './orchestrations';
import type { ToolNodeGateResult } from './orchestrationToolGuardrail';
import { runToolNodeGate } from './orchestrationToolGuardrail';
import { stripMarkdownJsonFence } from './outputSchema';
import { isPlainObject } from './plainObject';
import { callTool } from './tools';

const log = createDebug('soat:orchestrations');

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

/**
 * Fallback for when the AI SDK's own structured output is unavailable: parses
 * `content` itself, stripping a markdown code fence first — the shape a model
 * commonly wraps JSON in even when told to return it bare, which a plain
 * `JSON.parse` rejects outright. A parse failure is logged (see #747) rather
 * than silently reverting to `{ content }` with no signal, though the
 * artifact still degrades to `{ content }` so a run never fails on account of
 * the model's prose not being JSON.
 */
const parseAgentOutputContent = (content: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(stripMarkdownJsonFence(content));
    if (isPlainObject(parsed)) return parsed;
    log(
      'parseAgentOutput: output_schema configured but parsed content was not a JSON object (got %s)',
      typeof parsed
    );
  } catch (error) {
    log(
      'parseAgentOutput: output_schema configured but content did not parse as JSON: %s',
      error instanceof Error ? error.message : String(error)
    );
  }
  return { content };
};

/**
 * Builds an `agent` node's artifact. Without an `output_schema` the artifact
 * is always `{ content }` — the model's raw text response.
 *
 * With an `output_schema` configured, prefer the AI SDK's own structured
 * output (`generation.output.object`, produced by `buildStructuredOutput` at
 * generation time) — when the provider honors it, this is already a parsed,
 * schema-validated object and needs no further work. Only when that is
 * absent (a provider/model that ignores structured-output mode) does this
 * fall back to {@link parseAgentOutputContent}.
 */
const parseAgentOutput = (
  output: { content: unknown; object?: unknown } | undefined,
  outputSchema: object | undefined
): Record<string, unknown> => {
  const content = output?.content;
  if (!outputSchema) {
    return { content: content ?? null };
  }

  if (isPlainObject(output?.object)) {
    return output!.object as Record<string, unknown>;
  }

  if (typeof content !== 'string') {
    return { content: content ?? null };
  }

  return parseAgentOutputContent(content);
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
  // This node's 1-based retry attempt. Stamped on the generation next to the run
  // and node so a retried node's generations are told apart — the node execution
  // row stores no generation id, so this is what makes the run → generation
  // lookup exact rather than a guess from timestamps.
  nodeAttempt?: number;
  // The run's `tool_context`, forwarded to this generation so the agent's
  // `http`/`mcp`/`soat` tool calls carry the caller's context headers (#945).
  toolContext?: Record<string, string>;
}): Promise<NodeExecutionResult> => {
  const {
    node,
    state,
    projectIds,
    traceId,
    authHeader,
    runPublicId,
    triggerId,
    nodeAttempt,
    toolContext,
  } = args;
  const agentId = requireNodeField(node, 'agentId');

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
    agentId,
    messages,
    parentTraceId: traceId,
    authHeader,
    orchestrationRunId: runPublicId,
    nodeId: node.id,
    nodeAttempt,
    triggerId,
    toolContext,
  });

  if (result instanceof ReadableStream) {
    throw new DomainError(
      'ORCHESTRATION_NODE_FAILED',
      `Agent node '${node.id}' returned a streaming response, which is not supported in orchestrations.`
    );
  }

  const artifact = parseAgentOutput(result.output, node.outputSchema);
  return { kind: 'artifact', artifact, traceId: result.traceId };
};

export const executeToolNode = async (args: {
  node: OrchestrationNode;
  state: Record<string, unknown>;
  projectIds: number[];
  // The run's own project id — used to scope guardrail collection to the run's
  // project. Falls back to `projectIds[0]` when absent (direct-call callers).
  projectId?: number;
  authHeader?: string;
  // Run-scoped idempotency key, forwarded to the HTTP tool executor as the
  // `Idempotency-Key` request header (D7).
  idempotencyKey?: string;
  // The run's public id — threaded into the guardrail evaluation identity so a
  // guard can read `runtime.run.*`.
  orchestrationRunId?: string | null;
  // Set when re-dispatching after a class-C approval: the frozen (or edited)
  // arguments the human approved. Their presence bypasses the guardrail gate
  // entirely (the call was already adjudicated) and skips input mapping — the
  // approved args ARE the tool input. Re-evaluating here would re-route to
  // approval and loop forever (Q4: skip re-eval on resume).
  approvedArguments?: Record<string, unknown> | null;
  // The run's `tool_context`, forwarded to the tool call so a `{{context:}}`
  // header or preset on the tool resolves from the run's own bag — the same
  // reach an `agent` node's generation already has (#345).
  toolContext?: Record<string, string>;
}): Promise<NodeExecutionResult> => {
  const { node, state, projectIds, authHeader, idempotencyKey, toolContext } =
    args;
  const toolId = requireNodeField(node, 'toolId');

  const inputs =
    args.approvedArguments ?? applyInputMapping(node.inputMapping, state);

  // Guardrail interception (G4): classify the call at project + tool scope and
  // enact the strictest decision before dispatch (a zero-overhead passthrough
  // when no guardrail applies). Skipped entirely on an approved re-dispatch —
  // the call was already adjudicated at approval time (Q4).
  const scopeProjectId = args.projectId ?? projectIds[0];
  const gated: ToolNodeGateResult =
    args.approvedArguments != null || scopeProjectId === undefined
      ? { kind: 'execute', input: inputs }
      : await runToolNodeGate({
          node,
          inputs,
          projectId: scopeProjectId,
          authHeader,
          orchestrationRunId: args.orchestrationRunId,
        });
  if (gated.kind === 'result') return gated.result;

  const result = await callTool({
    projectIds,
    id: toolId,
    action: node.operationId,
    input: gated.input,
    authHeader,
    idempotencyKey,
    toolContext,
  });

  const artifact: Record<string, unknown> =
    typeof result === 'object' && result !== null
      ? (result as Record<string, unknown>)
      : { result };

  // Activity feed (G3 Phase 4): record the successful execution. This is the
  // run-scoped call site — a tool node has no agent in scope, so it attributes
  // to the run and node. Agent-generation-time tool calls are recorded by the
  // resolver instead (`recordToolActivity`), which this path deliberately does
  // not opt into: it threads no `ActivityCallContext`, so no call is recorded
  // twice. Fire-and-forget so a recording failure never affects the run.
  if (scopeProjectId !== undefined) {
    void emitActivityEntry({
      projectId: scopeProjectId,
      kind: 'action_executed',
      summary: `Tool '${toolId}' executed by node '${node.id}'`,
      detail: { nodeId: node.id, action: node.operationId },
      orchestrationRunId: args.orchestrationRunId,
      refId: toolId,
    });
  }

  return { kind: 'artifact', artifact };
};

export const executeTransformNode = (args: {
  node: OrchestrationNode;
  state: Record<string, unknown>;
}): NodeExecutionResult => {
  const { node, state } = args;
  const result = evaluateLogic(requireNodeField(node, 'expression'), state);
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
  const memoryId = requireNodeField(node, 'memoryId');

  const inputs = applyInputMapping(node.inputMapping, state);
  const memory = await db.Memory.findOne({
    where: { publicId: memoryId },
  });
  if (!memory)
    throw new DomainError(
      'ORCHESTRATION_NODE_FAILED',
      `Memory '${memoryId}' not found.`
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
  const label = String(
    evaluateLogic(requireNodeField(node, 'expression'), state)
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
  const duration = requireNodeField(node, 'duration');
  const ms = parseDuration(duration);
  const artifact = { waited: duration };
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
  toolContext?: Record<string, string>;
  parent: NestedRunParent;
}): Promise<unknown[]> => {
  const {
    items,
    parallelism,
    itemVariable,
    orchestrationId,
    projectIds,
    authHeader,
    toolContext,
    parent,
  } = args;
  const results: unknown[] = [];
  for (let i = 0; i < items.length; i += parallelism) {
    const batch = items.slice(i, i + parallelism);
    const batchResults = await Promise.all(
      batch.map((item) => {
        const itemInput: Record<string, unknown> = { [itemVariable]: item };
        return startNestedRun({
          orchestrationPublicId: orchestrationId,
          projectId: projectIds[0],
          projectIds,
          input: itemInput,
          authHeader,
          // A child run is still this run's work, so it inherits the parent's
          // context rather than starting with none (#945).
          toolContext,
          // Every item's run is attributable to the node that fanned it out, so
          // the loop's real cost is the sum of its children (#1135).
          parent,
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
  toolContext?: Record<string, string>;
  runPublicId?: string;
}): Promise<NodeExecutionResult> => {
  const { node, state, projectIds, authHeader, toolContext, runPublicId } =
    args;
  const orchestrationId = requireNodeField(node, 'orchestrationId');

  const collectionPath = node.collection ?? 'state.items';
  const itemVariable = node.itemVariable ?? 'item';
  const parallelism = node.parallelism ?? 5;
  const items = resolveLoopCollection({ collectionPath, state });
  const results = await runLoopBatches({
    items,
    parallelism,
    itemVariable,
    orchestrationId,
    projectIds,
    authHeader,
    toolContext,
    parent: { runId: runPublicId, nodeId: node.id },
  });

  return { kind: 'artifact', artifact: { results } };
};

export const executeSubOrchestrationNode = async (args: {
  node: OrchestrationNode;
  state: Record<string, unknown>;
  projectIds: number[];
  traceId: string | null;
  authHeader?: string;
  toolContext?: Record<string, string>;
  runPublicId?: string;
}): Promise<NodeExecutionResult> => {
  const { node, state, projectIds, authHeader, toolContext, runPublicId } =
    args;
  const orchestrationId = requireNodeField(node, 'orchestrationId');

  const input = applyInputMapping(node.inputMapping, state);
  const run = await startNestedRun({
    orchestrationPublicId: orchestrationId,
    projectId: projectIds[0],
    projectIds,
    input,
    authHeader,
    // A child run is still this run's work, so it inherits the parent's context
    // rather than starting with none (#945).
    toolContext,
    // The child is this node's work: its spend rolls up to this run (#1135).
    parent: { runId: runPublicId, nodeId: node.id },
    // A sub-orchestration is a synchronous child: its terminal output feeds this
    // node's artifact, so it must run to completion before continuing.
    wait: true,
  });

  return { kind: 'artifact', artifact: run.output ?? {} };
};
