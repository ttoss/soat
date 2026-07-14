import createDebug from 'debug';

import { DomainError } from '../errors';
import { detectCycleExcludingLoopNodes } from './orchestrationGraph';
import {
  buildPredecessors,
  computeDominators,
  transitivePredecessors,
} from './orchestrationGraphAnalysis';
import {
  checkReservedNodeNamespace,
  NODE_ARTIFACTS_STATE_KEY,
} from './orchestrationNodesNamespace';
import type { OrchestrationEdge, OrchestrationNode } from './orchestrations';
import { collectVarRefs } from './orchestrationVarRefs';

const log = createDebug('soat:orchestrations');

// ── Types ─────────────────────────────────────────────────────────────────

export type OrchestrationValidationIssue = {
  path: string;
  message: string;
};

export type OrchestrationValidationResult = {
  valid: boolean;
  errors: OrchestrationValidationIssue[];
  warnings: OrchestrationValidationIssue[];
};

export { collectVarRefs } from './orchestrationVarRefs';

const topSegment = (path: string): string => {
  return path.split('.')[0] as string;
};

// ── State key analysis ────────────────────────────────────────────────────

/**
 * The top-level state keys a node writes via its `stateMapping`. Keys are
 * `state.<path>` strings (a `state_mapping`'s own keys are its write
 * destinations); a key without the `state.` prefix is normalized to one,
 * mirroring `writeToState`. The top-level segment of the remainder is the key
 * that becomes available to downstream nodes.
 */
const writtenStateKeys = (node: OrchestrationNode): string[] => {
  if (!node.stateMapping) return [];
  const keys: string[] = [];
  for (const statePath of Object.keys(node.stateMapping)) {
    const normalizedPath = statePath.startsWith('state.')
      ? statePath
      : `state.${statePath}`;
    const remainder = normalizedPath.slice('state.'.length);
    if (remainder.length > 0) keys.push(topSegment(remainder));
  }
  return keys;
};

/**
 * Top-level keys seeded into state by the run input. Accepts a JSON Schema
 * (uses `properties`) or a plain object (uses its own keys, minus schema
 * keywords). Returns an empty set when no usable shape is present.
 */
const inputStateKeys = (
  inputSchema: object | null | undefined
): Set<string> => {
  if (!inputSchema || typeof inputSchema !== 'object') return new Set();
  const schema = inputSchema as Record<string, unknown>;
  const properties = schema['properties'];
  if (properties && typeof properties === 'object') {
    return new Set(Object.keys(properties as Record<string, unknown>));
  }
  const schemaKeywords = new Set([
    'type',
    'required',
    '$schema',
    'additionalProperties',
    'title',
    'description',
  ]);
  return new Set(
    Object.keys(schema).filter((k) => {
      return !schemaKeywords.has(k);
    })
  );
};

// ── Node-level validation ─────────────────────────────────────────────────

const REQUIRED_NODE_FIELDS: Partial<
  Record<OrchestrationNode['type'], keyof OrchestrationNode>
> = {
  agent: 'agentId',
  tool: 'toolId',
  transform: 'expression',
  condition: 'expression',
  approval: 'toolId',
  memory_write: 'memoryId',
  delay: 'duration',
  loop: 'orchestrationId',
  poll: 'toolId',
  sub_orchestration: 'orchestrationId',
};

/**
 * A tool node uses `operationId`, not `action`; flag the legacy field name.
 */
const toolNodeShapeIssues = (args: {
  node: OrchestrationNode;
  basePath: string;
}): OrchestrationValidationIssue[] => {
  const { node, basePath } = args;
  const raw = node as Record<string, unknown>;
  if (raw['action'] !== undefined && !node.operationId) {
    return [
      {
        path: `${basePath}.action`,
        message: `tool node '${node.id}' uses 'operationId', not 'action'; rename the field to 'operationId'.`,
      },
    ];
  }
  return [];
};

/**
 * A poll node needs three fields; REQUIRED_NODE_FIELDS only enforces the
 * primary one (toolId), so the exit condition and cadence are checked here.
 */
const pollNodeShapeIssues = (args: {
  node: OrchestrationNode;
  basePath: string;
}): OrchestrationValidationIssue[] => {
  const { node, basePath } = args;
  const issues: OrchestrationValidationIssue[] = [];
  if (node.exitCondition === undefined || node.exitCondition === null) {
    issues.push({
      path: `${basePath}.exit_condition`,
      message: `poll node '${node.id}' is missing required field 'exit_condition' (the JSON Logic stop condition).`,
    });
  }
  if (!node.interval) {
    issues.push({
      path: `${basePath}.interval`,
      message: `poll node '${node.id}' is missing required field 'interval'.`,
    });
  }
  return issues;
};

const validateNodeShape = (args: {
  node: OrchestrationNode;
  index: number;
}): OrchestrationValidationIssue[] => {
  const { node, index } = args;
  const issues: OrchestrationValidationIssue[] = [];
  const basePath = `nodes[${index}]`;

  if (!node.id || typeof node.id !== 'string') {
    issues.push({ path: `${basePath}.id`, message: '`id` is required.' });
  }
  if (!node.type) {
    issues.push({ path: `${basePath}.type`, message: '`type` is required.' });
    return issues;
  }

  const requiredField = REQUIRED_NODE_FIELDS[node.type];
  if (requiredField) {
    const value = node[requiredField];
    if (value === undefined || value === null) {
      issues.push({
        path: `${basePath}.${requiredField}`,
        message: `${node.type} node '${node.id}' is missing required field '${requiredField}'.`,
      });
    }
  }

  if (node.type === 'tool') {
    issues.push(...toolNodeShapeIssues({ node, basePath }));
  }

  if (node.type === 'poll') {
    issues.push(...pollNodeShapeIssues({ node, basePath }));
  }

  return issues;
};

const checkNodeShapes = (
  nodes: OrchestrationNode[]
): OrchestrationValidationIssue[] => {
  const errors: OrchestrationValidationIssue[] = [];
  const seenIds = new Set<string>();
  for (const [index, node] of nodes.entries()) {
    errors.push(...validateNodeShape({ node, index }));
    if (typeof node.id === 'string') {
      if (seenIds.has(node.id)) {
        errors.push({
          path: `nodes[${index}].id`,
          message: `Duplicate node id '${node.id}'.`,
        });
      }
      seenIds.add(node.id);
    }
  }
  return errors;
};

const checkEdges = (args: {
  edges: OrchestrationEdge[];
  nodeIdSet: Set<string>;
}): OrchestrationValidationIssue[] => {
  const { edges, nodeIdSet } = args;
  const errors: OrchestrationValidationIssue[] = [];
  for (const [index, edge] of edges.entries()) {
    if (!nodeIdSet.has(edge.from)) {
      errors.push({
        path: `edges[${index}].from`,
        message: `Edge references unknown node '${edge.from}'.`,
      });
    }
    if (!nodeIdSet.has(edge.to)) {
      errors.push({
        path: `edges[${index}].to`,
        message: `Edge references unknown node '${edge.to}'.`,
      });
    }
  }
  return errors;
};

const buildWriters = (nodes: OrchestrationNode[]): Map<string, Set<string>> => {
  const writers = new Map<string, Set<string>>();
  for (const node of nodes) {
    for (const key of writtenStateKeys(node)) {
      const set = writers.get(key) ?? new Set<string>();
      set.add(node.id);
      writers.set(key, set);
    }
  }
  return writers;
};

type RefContext = {
  inputKeys: Set<string>;
  writers: Map<string, Set<string>>;
  ancestors: Set<string>;
  ancestorDominators: Set<string>;
  allNodeIds: Set<string>;
};

/**
 * Classifies a `{var: "nodes.<nodeId>..."}` reference: `nodes.<nodeId>...` is
 * written unconditionally by the engine the moment `<nodeId>` completes
 * (`writeNodeArtifact`) — not via a declared `state_mapping` — so it needs
 * its own reachability check against `<nodeId>` directly (must both exist and
 * be an upstream/ancestor node), rather than the general writers-map lookup
 * `classifyRef` uses for ordinary state keys. A bare `{"var": "nodes"}` (no
 * node id segment) is left unchecked, matching the open-input-contract
 * behavior for ordinary keys.
 */
const classifyNodesRef = (args: {
  refPath: string;
  ctx: RefContext;
}): 'ok' | 'unwritten' | 'conditional' => {
  const { refPath, ctx } = args;
  const nodeId = refPath.split('.')[1];
  if (!nodeId) return 'ok';
  if (!ctx.allNodeIds.has(nodeId) || !ctx.ancestors.has(nodeId)) {
    return 'unwritten';
  }
  return ctx.ancestorDominators.has(nodeId) ? 'ok' : 'conditional';
};

/**
 * Classifies a single `{var: refPath}` reference against the run state:
 * - `ok`          — satisfied by input_schema or guaranteed by an upstream writer
 * - `unwritten`   — no upstream node writes it
 * - `conditional` — written upstream, but only on some branches (not dominated)
 */
const classifyRef = (args: {
  refPath: string;
  ctx: RefContext;
}): 'ok' | 'unwritten' | 'conditional' => {
  const { refPath, ctx } = args;
  const key = topSegment(refPath);
  // The `input` namespace is the only place run input is seeded (see
  // startOrchestrationRun), so any `{ "var": "input.<name>" }` reference is
  // satisfiable regardless of the declared input_schema — mirroring the
  // pipeline/formation `input.` convention. A *flat* `{ "var": "<name>" }` is
  // never seeded from run input (even when input_schema declares `<name>`) —
  // it can only be satisfied by an upstream node's own `state_mapping` write,
  // handled by the general writers-map lookup below.
  if (key === 'input') return 'ok';
  if (key === NODE_ARTIFACTS_STATE_KEY)
    return classifyNodesRef({ refPath, ctx });
  const keyWriters = ctx.writers.get(key) ?? new Set<string>();
  const upstreamWriters = [...keyWriters].filter((w) => {
    return ctx.ancestors.has(w);
  });
  if (upstreamWriters.length === 0) return 'unwritten';
  const guaranteed = upstreamWriters.some((w) => {
    return ctx.ancestorDominators.has(w);
  });
  return guaranteed ? 'ok' : 'conditional';
};

const checkNodeReachability = (args: {
  node: OrchestrationNode;
  index: number;
  ctx: RefContext;
}): OrchestrationValidationResult => {
  const { node, index, ctx } = args;
  const errors: OrchestrationValidationIssue[] = [];
  const warnings: OrchestrationValidationIssue[] = [];
  for (const [mappingKey, value] of Object.entries(node.inputMapping ?? {})) {
    for (const refPath of collectVarRefs(value)) {
      const verdict = classifyRef({ refPath, ctx });
      const key = topSegment(refPath);
      const path = `nodes[${index}].input_mapping.${mappingKey}`;
      // `nodes.<nodeId>` is written exclusively by the referenced node
      // completing, so an unwritten reference is always an error. A plain
      // state key can never be satisfied by run input either (input is
      // seeded under `state.input` only), but a parallel non-ancestor
      // node's state_mapping may still write it before this node runs, so
      // without a declared input_schema the graph stays permissive.
      if (verdict === 'unwritten' && key === NODE_ARTIFACTS_STATE_KEY) {
        const referencedNodeId = refPath.split('.')[1];
        errors.push({
          path,
          message: `references ${refPath} but '${referencedNodeId}' is not an earlier (upstream) node in this graph.`,
        });
      } else if (verdict === 'unwritten' && ctx.inputKeys.size > 0) {
        // With a declared input_schema the input contract is closed, so a
        // key not written upstream is a hard error. Point the author at the
        // real fix: run input is only readable through the input namespace.
        const suffix = ctx.inputKeys.has(key)
          ? `'${key}' is declared in input_schema, but run input is seeded under the 'input' namespace only — reference it as {"var": "input.${key}"}.`
          : `it is not declared in input_schema either.`;
        errors.push({
          path,
          message: `references state.${refPath} but no upstream node writes 'state.${key}'; ${suffix}`,
        });
      } else if (verdict === 'conditional') {
        warnings.push({
          path,
          message: `state.${key} is only written on a conditional branch and may be undefined when this node runs.`,
        });
      }
    }
  }
  return { valid: errors.length === 0, errors, warnings };
};

/**
 * inputMapping state reference reachability. Only meaningful on an acyclic
 * graph with no dangling edges, so the caller gates this on those checks.
 */
const checkReachability = (args: {
  nodes: OrchestrationNode[];
  edges: OrchestrationEdge[];
  nodeIds: string[];
  inputSchema?: object | null;
}): OrchestrationValidationResult => {
  const { nodes, edges, nodeIds, inputSchema } = args;
  const errors: OrchestrationValidationIssue[] = [];
  const warnings: OrchestrationValidationIssue[] = [];
  const inputKeys = inputStateKeys(inputSchema);
  const preds = buildPredecessors(edges);
  const dominators = computeDominators({ nodeIds, edges, preds });
  const writers = buildWriters(nodes);
  const allNodeIds = new Set(nodeIds);

  for (const [index, node] of nodes.entries()) {
    if (!node.inputMapping) continue;
    const ctx: RefContext = {
      inputKeys,
      writers,
      ancestors: transitivePredecessors({ nodeId: node.id, preds }),
      ancestorDominators: dominators.get(node.id) ?? new Set<string>(),
      allNodeIds,
    };
    const res = checkNodeReachability({ node, index, ctx });
    errors.push(...res.errors);
    warnings.push(...res.warnings);
  }
  return { valid: errors.length === 0, errors, warnings };
};

// ── Top-level validation ──────────────────────────────────────────────────

export const validateOrchestrationGraph = (args: {
  nodes: OrchestrationNode[];
  edges: OrchestrationEdge[];
  inputSchema?: object | null;
}): OrchestrationValidationResult => {
  const { nodes, edges, inputSchema } = args;
  if (!Array.isArray(nodes)) {
    return {
      valid: false,
      errors: [{ path: 'nodes', message: '`nodes` must be an array.' }],
      warnings: [],
    };
  }

  const errors: OrchestrationValidationIssue[] = [];
  const warnings: OrchestrationValidationIssue[] = [];

  errors.push(...checkNodeShapes(nodes));
  errors.push(...checkReservedNodeNamespace({ nodes }));

  const nodeIds = nodes
    .map((n) => {
      return n.id;
    })
    .filter((id): id is string => {
      return typeof id === 'string';
    });
  errors.push(...checkEdges({ edges, nodeIdSet: new Set(nodeIds) }));

  // Loop nodes legitimately introduce iteration via a sub-orchestration, so
  // they (and edges touching them) are excluded from cycle detection —
  // but a genuine cycle among the remaining nodes still fails validation.
  const cyclic = detectCycleExcludingLoopNodes(nodes, edges);
  if (cyclic) {
    errors.push({
      path: 'edges',
      message: 'Cycle detected in orchestration graph.',
    });
  }

  const danglingEdges = errors.some((e) => {
    return e.path.startsWith('edges[');
  });
  if (!cyclic && !danglingEdges) {
    const reach = checkReachability({ nodes, edges, nodeIds, inputSchema });
    errors.push(...reach.errors);
    warnings.push(...reach.warnings);
  }

  log(
    'validateOrchestrationGraph: errors=%d warnings=%d',
    errors.length,
    warnings.length
  );

  return { valid: errors.length === 0, errors, warnings };
};

/**
 * Runs static validation and throws `ORCHESTRATION_VALIDATION_FAILED` when
 * there are blocking errors. Warnings never block — they are surfaced through
 * the dedicated validate endpoint. Shared by the create and update paths so
 * the rule lives in one place.
 */
export const assertOrchestrationValid = (args: {
  nodes: OrchestrationNode[];
  edges: OrchestrationEdge[];
  inputSchema?: object | null;
}): void => {
  const result = validateOrchestrationGraph(args);
  if (result.valid) return;
  const summary = result.errors
    .map((e) => {
      return `${e.path}: ${e.message}`;
    })
    .join('; ');
  throw new DomainError(
    'ORCHESTRATION_VALIDATION_FAILED',
    `Orchestration validation failed: ${summary}`,
    { errors: result.errors, warnings: result.warnings }
  );
};

/**
 * Validates the resulting graph of a partial update — only when a structural
 * field (nodes, edges, input_schema) changes — by merging the incoming update
 * with the persisted values. Throws on blocking errors.
 */
export const assertOrchestrationUpdateValid = (args: {
  update: {
    nodes?: OrchestrationNode[];
    edges?: OrchestrationEdge[];
    inputSchema?: object | null;
  };
  persisted: {
    nodes: OrchestrationNode[];
    edges: OrchestrationEdge[];
    inputSchema: object | null;
  };
}): void => {
  const { update, persisted } = args;
  if (
    update.nodes === undefined &&
    update.edges === undefined &&
    update.inputSchema === undefined
  ) {
    return;
  }
  assertOrchestrationValid({
    nodes: update.nodes ?? persisted.nodes,
    edges: update.edges ?? persisted.edges,
    inputSchema:
      update.inputSchema !== undefined
        ? update.inputSchema
        : persisted.inputSchema,
  });
};
