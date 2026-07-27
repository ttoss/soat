import type {
  NodeRetryPolicy,
  OrchestrationEdge,
  OrchestrationNode,
  RetryBackoffStrategy,
} from './orchestrations';

/**
 * The boundary between the snake_case orchestration graph on the wire and the
 * camelCase `OrchestrationNode` / `OrchestrationEdge` the engine reads.
 *
 * A graph is **author-authored data**, not a resource the platform owns, and it
 * is persisted as JSON. Two consequences shape this module:
 *
 * - **The internal type stays camelCase.** 22 modules read `node.toolId` and
 *   every orchestration already stored in the database has camelCase node JSON.
 *   Flipping the type would need a data migration; mapping at the boundary needs
 *   none, so the conversion lives here and nowhere else.
 * - **Every value is copied as a value.** `expression`, `arguments`,
 *   `input_mapping`, `state_mapping`, `output_schema`, `reasoning`, `evidence`,
 *   `predicted_impact` and `exit_condition` are JSON Logic or caller-owned
 *   payloads whose inner keys the author wrote deliberately — a `var` path like
 *   `{"var": "state.max_daily_budget"}` must round-trip byte-for-byte. Nothing
 *   here recurses into a value, which is the property that makes #737's bug
 *   class unrepresentable rather than merely avoided.
 *
 * Both directions are explicit field lists, so a field added to the spec but
 * forgotten here fails `strictFields` on write instead of being silently dropped.
 */

/** Drops keys whose value is `undefined` so a node round-trips without gaining them. */
const compact = <T extends Record<string, unknown>>(value: T): Partial<T> => {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => {
      return v !== undefined;
    })
  ) as Partial<T>;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

// ── retry ────────────────────────────────────────────────────────────────

const parseRetry = (value: unknown): NodeRetryPolicy | undefined => {
  if (!isRecord(value)) return undefined;

  const backoff = isRecord(value.backoff) ? value.backoff : undefined;

  return compact({
    maxAttempts: value.max_attempts as number | undefined,
    backoff: backoff
      ? compact({
          strategy: backoff.strategy as RetryBackoffStrategy | undefined,
          delayMs: backoff.delay_ms as number | undefined,
          maxDelayMs: backoff.max_delay_ms as number | undefined,
        })
      : undefined,
  }) as NodeRetryPolicy;
};

const mapRetry = (retry: NodeRetryPolicy | undefined) => {
  if (!retry) return undefined;

  return compact({
    max_attempts: retry.maxAttempts,
    backoff: retry.backoff
      ? compact({
          strategy: retry.backoff.strategy,
          delay_ms: retry.backoff.delayMs,
          max_delay_ms: retry.backoff.maxDelayMs,
        })
      : undefined,
  });
};

// ── nodes ────────────────────────────────────────────────────────────────

/** Wire node -> engine node. Unknown keys are dropped; `strictFields` has already rejected them. */
export const parseOrchestrationNode = (raw: unknown): OrchestrationNode => {
  const node = isRecord(raw) ? raw : {};

  return compact({
    id: node.id,
    type: node.type,
    agentId: node.agent_id,
    toolId: node.tool_id,
    operationId: node.operation_id,
    expression: node.expression,
    prompt: node.prompt,
    options: node.options,
    arguments: node.arguments,
    expiresIn: node.expires_in,
    instructions: node.instructions,
    reasoning: node.reasoning,
    evidence: node.evidence,
    predictedImpact: node.predicted_impact,
    memoryId: node.memory_id,
    collection: node.collection,
    itemVariable: node.item_variable,
    parallelism: node.parallelism,
    exitCondition: node.exit_condition,
    interval: node.interval,
    failOnTimeout: node.fail_on_timeout,
    duration: node.duration,
    mode: node.mode,
    eventType: node.event_type,
    orchestrationId: node.orchestration_id,
    maxIterations: node.max_iterations,
    inputMapping: node.input_mapping,
    stateMapping: node.state_mapping,
    outputSchema: node.output_schema,
    retry: parseRetry(node.retry),
  }) as OrchestrationNode;
};

/** Engine node -> wire node, matching `OrchestrationNode` in the spec. */
export const mapOrchestrationNode = (node: OrchestrationNode) => {
  return compact({
    id: node.id,
    type: node.type,
    agent_id: node.agentId,
    tool_id: node.toolId,
    operation_id: node.operationId,
    expression: node.expression,
    prompt: node.prompt,
    options: node.options,
    arguments: node.arguments,
    expires_in: node.expiresIn,
    instructions: node.instructions,
    reasoning: node.reasoning,
    evidence: node.evidence,
    predicted_impact: node.predictedImpact,
    memory_id: node.memoryId,
    collection: node.collection,
    item_variable: node.itemVariable,
    parallelism: node.parallelism,
    exit_condition: node.exitCondition,
    interval: node.interval,
    fail_on_timeout: node.failOnTimeout,
    duration: node.duration,
    mode: node.mode,
    event_type: node.eventType,
    orchestration_id: node.orchestrationId,
    max_iterations: node.maxIterations,
    input_mapping: node.inputMapping,
    state_mapping: node.stateMapping,
    output_schema: node.outputSchema,
    retry: mapRetry(node.retry),
  });
};

// ── edges ────────────────────────────────────────────────────────────────

export const parseOrchestrationEdge = (raw: unknown): OrchestrationEdge => {
  const edge = isRecord(raw) ? raw : {};

  return compact({
    from: edge.from,
    to: edge.to,
    condition: edge.condition,
    activationGroup: edge.activation_group,
    activationCondition: edge.activation_condition,
  }) as OrchestrationEdge;
};

export const mapOrchestrationEdge = (edge: OrchestrationEdge) => {
  return compact({
    from: edge.from,
    to: edge.to,
    condition: edge.condition,
    activation_group: edge.activationGroup,
    activation_condition: edge.activationCondition,
  });
};

// ── graph helpers ────────────────────────────────────────────────────────

/** `undefined` in, `undefined` out — so a PATCH that omits `nodes` leaves them alone. */
export const parseOrchestrationNodes = (
  raw: unknown
): OrchestrationNode[] | undefined => {
  return Array.isArray(raw) ? raw.map(parseOrchestrationNode) : undefined;
};

export const parseOrchestrationEdges = (
  raw: unknown
): OrchestrationEdge[] | undefined => {
  return Array.isArray(raw) ? raw.map(parseOrchestrationEdge) : undefined;
};

export const parseOrchestrationGraph = (args: {
  nodes: unknown;
  edges: unknown;
}): { nodes: OrchestrationNode[]; edges: OrchestrationEdge[] } => {
  return {
    nodes: parseOrchestrationNodes(args.nodes) ?? [],
    edges: parseOrchestrationEdges(args.edges) ?? [],
  };
};

export const mapOrchestrationGraph = (args: {
  nodes: OrchestrationNode[];
  edges: OrchestrationEdge[];
}) => {
  return {
    nodes: args.nodes.map(mapOrchestrationNode),
    edges: args.edges.map(mapOrchestrationEdge),
  };
};
