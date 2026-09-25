import createDebug from 'debug';

import { DomainError } from '../errors';
import { emitActivityEntry } from './activity';
import { createGeneration } from './agentGeneration';
import type { EmbeddingBillingProjectId } from './embedding';
import { applyInputMapping, evaluateLogic } from './jsonLogicMapping';
import { searchKnowledge } from './knowledge';
import { parseDuration } from './orchestrationDuration';
import { requireNodeField } from './orchestrationNodeFields';
import type { NodeExecutionResult } from './orchestrationNodeTypes';
import type { OrchestrationNode } from './orchestrations';
import type { ToolNodeGateResult } from './orchestrationToolGuardrail';
import { runToolNodeGate } from './orchestrationToolGuardrail';
import { stripMarkdownJsonFence } from './outputSchema';
import { isPlainObject } from './plainObject';
import { isStringRecord } from './tags';
import { callTool } from './tools';

const log = createDebug('soat:orchestrations');

/**
 * Writes `value` at a dotted `path` inside `target`, building nested objects:
 * JSON-Logic's `var` descends dot-paths, so a flat `target["a.b"]` key reads
 * back as null.
 */
export const writeAtDottedPath = (args: {
  target: Record<string, unknown>;
  path: string;
  value: unknown;
}): void => {
  const segments = args.path.split('.');
  let cursor = args.target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i] as string;
    const next = cursor[segment];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1] as string] = args.value;
};

const writeToState = (
  path: string,
  value: unknown,
  state: Record<string, unknown>
): void => {
  const normalizedPath = path.startsWith('state.') ? path : `state.${path}`;
  writeAtDottedPath({
    target: state,
    path: normalizedPath.slice('state.'.length),
    value,
  });
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
    // The evaluator returns references, so `{ "var": "state" }` resolves to
    // the live object — writing it back uncloned nests state inside itself and
    // crashes serialization at the next checkpoint.
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
 * `JSON.parse` rejects outright. A parse failure is logged and read as `null`,
 * so a run never fails on account of the model's prose not being JSON.
 */
const parseAgentOutputContent = (
  content: string
): Record<string, unknown> | null => {
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
  return null;
};

/**
 * Builds an `agent` node's artifact, which always has the same two keys:
 * `content` is the model's text response and `object` the parsed value when a
 * schema applied, `null` otherwise. One shape means one `state_mapping` reads
 * a node whether or not a schema is in play, and `output.content` never stops
 * resolving because a schema was added.
 *
 * `generation.output.object` is preferred wherever it exists: whichever schema
 * asked for it — the agent's own or the node's — `buildStructuredOutput`
 * already parsed and validated it at generation time. Only a node that
 * declares a schema and got no object back (a provider/model that ignores
 * structured-output mode) re-reads the text through
 * {@link parseAgentOutputContent}; a node that declares none never does, since
 * prose that happens to be JSON is not an answer anyone asked for.
 */
const parseAgentOutput = (
  output: { content: unknown; object?: unknown } | undefined,
  outputSchema: object | undefined
): Record<string, unknown> => {
  const content = output?.content ?? null;

  if (isPlainObject(output?.object)) {
    return { content, object: output.object };
  }

  if (!outputSchema || typeof content !== 'string') {
    return { content, object: null };
  }

  return { content, object: parseAgentOutputContent(content) };
};

export const executeAgentNode = async (args: {
  node: OrchestrationNode;
  state: Record<string, unknown>;
  projectIds: number[];
  traceId: string | null;
  authHeader?: string;
  // Stamped onto the generation's usage event so spend rolls up per run, per
  // node and per trigger.
  runPublicId?: string;
  triggerId?: string;
  // The node execution row stores no generation id, so this is what tells a
  // retried node's generations apart without guessing from timestamps.
  nodeAttempt?: number;
  // The run's `tool_context`, forwarded to this generation so the agent's
  // `http`/`mcp`/`soat` tool calls carry the caller's context headers.
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
  // guard can read `runtime.orchestrations.*`.
  orchestrationRunId?: string | null;
  // The arguments a human approved. Their presence bypasses the guardrail gate
  // and input mapping — the call was already adjudicated, and re-evaluating
  // would re-route to approval and loop forever.
  approvedArguments?: Record<string, unknown> | null;
  // The run's `tool_context`, forwarded to the tool call so a `{{context:}}`
  // header or preset on the tool resolves from the run's own bag — the same
  // reach an `agent` node's generation already has.
  toolContext?: Record<string, string>;
}): Promise<NodeExecutionResult> => {
  const { node, state, projectIds, authHeader, idempotencyKey, toolContext } =
    args;
  const toolId = requireNodeField(node, 'toolId');

  const inputs =
    args.approvedArguments ?? applyInputMapping(node.inputMapping, state);

  // Classify at project + tool scope and enact the strictest decision before
  // dispatch. Skipped on an approved re-dispatch, already adjudicated.
  const scopeProjectId = args.projectId ?? projectIds[0];
  const gated: ToolNodeGateResult =
    args.approvedArguments != null || scopeProjectId === undefined
      ? { kind: 'execute', input: inputs, guardrailIds: [] }
      : await runToolNodeGate({
          node,
          inputs,
          projectId: scopeProjectId,
          authHeader,
          orchestrationRunId: args.orchestrationRunId,
        });
  if (gated.kind === 'result') return gated.result;

  const result = await callTool({
    // `runToolNodeGate` adjudicated this node's call before dispatch.
    guardrails: 'already-adjudicated',
    projectIds,
    id: toolId,
    action: node.operationId,
    input: gated.input,
    authHeader,
    idempotencyKey,
    toolContext,
    attribution: {
      orchestrationRunId: args.orchestrationRunId,
      nodeId: node.id,
      guardrailIds: gated.guardrailIds,
    },
  });

  const artifact: Record<string, unknown> =
    typeof result === 'object' && result !== null
      ? (result as Record<string, unknown>)
      : { result };

  // The run-scoped call site: a tool node has no agent in scope. Threading no
  // `ActivityCallContext` is what keeps the resolver's own `recordToolActivity`
  // from recording the same call twice. Fire-and-forget.
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
  /** The run's own project — what the query embedding is billed to. */
  billingProjectId: EmbeddingBillingProjectId;
}): Promise<NodeExecutionResult> => {
  const { node, state, projectIds } = args;
  const inputs = applyInputMapping(node.inputMapping, state);

  const results = await searchKnowledge({
    projectIds,
    billingProjectId: args.billingProjectId,
    query: typeof inputs['query'] === 'string' ? inputs['query'] : undefined,
    memoryStoreIds: Array.isArray(inputs['memoryStoreIds'])
      ? (inputs['memoryStoreIds'] as string[])
      : undefined,
    tags: isStringRecord(inputs['tags']) ? inputs['tags'] : undefined,
  });

  return { kind: 'artifact', artifact: { results } };
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
