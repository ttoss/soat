import createDebug from 'debug';

import type { CollectedGuardrail } from './guardrailCollection';
import { collectDocumentVarPaths } from './guardrailDocument';
import type { GuardrailEvaluationContext } from './guardrailEvaluation';
import { parseRuntimeKey, type RuntimeKey } from './guardrailRuntimeCatalog';
import {
  resolveRuntimeMetric,
  type RuntimeEntities,
  runtimeEntities,
} from './guardrailRuntimeMetrics';
import { isPlainObject } from './plainObject';
import { callTool } from './tools';

const log = createDebug('soat:guardrails');

// How the effective `context.*` was produced for one guardrail evaluation —
// recorded on the audit record (guardrails.md — Evaluation Audit Record).
export type GuardrailContextSource = 'caller' | 'tool' | 'merged' | 'none';

/** Orchestration-run state feeding `runtime.orchestrations.node_attempt`; absent outside a run. */
export type SoatRunContext = {
  nodeAttempt?: number | null;
};

/** The identity + call inputs every `runtime.*` / snapshot resolution reads from. */
export type GuardrailCallIdentity = {
  projectId: number;
  projectPublicId: string;
  // The guardrail being evaluated, for `runtime.guardrails.*`. Set per
  // guardrail, since the rest of the runtime context is shared by every
  // guardrail applying to the call.
  guardrailId?: string | null;
  agentId?: string | null;
  toolId?: string | null;
  toolName?: string | null;
  action?: string | null;
  orchestrationRunId?: string | null;
  run?: SoatRunContext | null;
};

// Reads a dotted path (`a.b.c`) off a nested object, returning `undefined` when
// any segment is missing — the caller maps that to fail-closed `null`.
const getByPath = (root: unknown, path: string): unknown => {
  let node: unknown = root;
  for (const segment of path.split('.')) {
    if (!isPlainObject(node)) return undefined;
    node = node[segment];
  }
  return node;
};

// Sets a dotted path (`projects.cost_usd.24h`) into a nested object, creating
// intermediate objects as needed.
const setByPath = (
  root: Record<string, unknown>,
  path: string,
  value: unknown
): void => {
  const segments = path.split('.');
  let node = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const key = segments[i];
    if (!isPlainObject(node[key])) {
      node[key] = {};
    }
    node = node[key] as Record<string, unknown>;
  }
  node[segments[segments.length - 1]] = value;
};

// The synchronous keys: the request fact and each module's identity. The
// nested shape mirrors the dotted keys so `{ var: 'runtime.tools.id' }`
// resolves.
const buildDeterministicRuntime = (
  identity: GuardrailCallIdentity
): Record<string, unknown> => {
  return {
    action: identity.action ?? null,
    tools: { id: identity.toolId ?? null, name: identity.toolName ?? null },
    agents: { id: identity.agentId ?? null },
    projects: { id: identity.projectPublicId },
    orchestrations: { node_attempt: identity.run?.nodeAttempt ?? null },
  };
};

// Distinguishes "leave the key unset" (→ null → fail-closed) from a resolved
// `null`, which a failed query writes explicitly.
const UNRESOLVED = Symbol('unresolved');

// A call with no entity of the key's module (no agent, no run, an inline
// tool) leaves it unresolved rather than reading 0 and letting a ceiling pass.
const resolveMetricKey = async (args: {
  key: Extract<RuntimeKey, { kind: 'metric' }>;
  path: string;
  entities: RuntimeEntities;
  now: Date;
}): Promise<number | null | typeof UNRESOLVED> => {
  try {
    const value = await resolveRuntimeMetric({
      module: args.key.module,
      metric: args.key.metric,
      window: args.key.window,
      entities: args.entities,
      now: args.now,
    });
    return value === undefined ? UNRESOLVED : value;
  } catch (error) {
    log('buildGuardrailRuntimeContext: failed path=%s %o', args.path, error);
    return null;
  }
};

/**
 * Populates the `runtime.*` namespace for a call, filling **only** the
 * `runtime.<module>.<metric>.<window>` keys the applying guardrails reference
 * (`referencedRuntimePaths`); identity keys are set synchronously. Counts and
 * sums read the usage meter live at evaluation time, scoped to the module's
 * entity in the call (`guardrailRuntimeMetrics.ts`). Fail-closed throughout: a
 * query that throws, a key whose entity the call does not have, or a cost
 * whose spend cannot be priced leaves the key `null`.
 */
export const buildGuardrailRuntimeContext = async (args: {
  identity: GuardrailCallIdentity;
  referencedRuntimePaths: string[];
  now: Date;
}): Promise<Record<string, unknown>> => {
  const runtime = buildDeterministicRuntime(args.identity);
  const entities = runtimeEntities({
    projectId: args.identity.projectId,
    guardrailId: args.identity.guardrailId,
    agentId: args.identity.agentId,
    toolId: args.identity.toolId,
    orchestrationRunId: args.identity.orchestrationRunId,
  });

  for (const path of args.referencedRuntimePaths) {
    const key = parseRuntimeKey(path);
    if (key?.kind !== 'metric') continue;
    const value = await resolveMetricKey({
      key,
      path,
      entities,
      now: args.now,
    });
    if (value !== UNRESOLVED) {
      setByPath(runtime, path.slice('runtime.'.length), value);
    }
  }

  return runtime;
};

const isGuardrailScopedPath = (path: string): boolean => {
  const key = parseRuntimeKey(path);
  return key?.kind === 'metric' && key.module === 'guardrails';
};

/**
 * The runtime context one guardrail evaluates against: the call's shared
 * context, plus the `runtime.guardrails.*` keys this guardrail references,
 * which answer about the guardrail itself and so differ per guardrail.
 */
export const runtimeForGuardrail = async (args: {
  shared: Record<string, unknown>;
  guardrail: CollectedGuardrail;
  identity: GuardrailCallIdentity;
  now: Date;
}): Promise<Record<string, unknown>> => {
  const paths = collectDocumentVarPaths(args.guardrail.document).filter(
    isGuardrailScopedPath
  );
  if (paths.length === 0) return args.shared;
  const own = await buildGuardrailRuntimeContext({
    identity: { ...args.identity, guardrailId: args.guardrail.guardrailId },
    referencedRuntimePaths: paths,
    now: args.now,
  });
  return { ...args.shared, guardrails: own.guardrails };
};

// ── Per-guardrail context tool ───────────────────────────────────────────────

const DEFAULT_CONTEXT_TOOL_TIMEOUT_MS = 5000;

// Read per call so operators (and tests) can tune the context-tool timeout via
// SOAT_GUARDRAIL_CONTEXT_TIMEOUT_MS without a restart-time capture.
const contextToolTimeoutMs = (): number => {
  const raw = Number(process.env.SOAT_GUARDRAIL_CONTEXT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_CONTEXT_TOOL_TIMEOUT_MS;
};

/**
 * The call a context tool is asked about, sent as its input under `call`.
 * `args` are the arguments the guard evaluates, so the tool and the guard judge
 * the same call.
 */
export type GuardrailProposedCall = {
  action: string | null;
  tool: { id: string | null; name: string | null };
  args: Record<string, unknown>;
};

export const proposedCall = (args: {
  identity: GuardrailCallIdentity;
  effectiveArgs: Record<string, unknown>;
}): GuardrailProposedCall => {
  return {
    action: args.identity.action ?? null,
    tool: {
      id: args.identity.toolId ?? null,
      name: args.identity.toolName ?? null,
    },
    args: args.effectiveArgs,
  };
};

const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error('context tool timed out'));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
};

/**
 * Calls a guardrail's `context_tool_id` at evaluation time under the calling
 * agent's credentials (the resolver's `authHeader`), returning its output object
 * for the `context.*` namespace. Called on every gated call, uncached: an answer
 * about one call's target is wrong for the next, and two identical writes must
 * each read the state the other leaves. Bounded by a per-call timeout.
 * Fail-closed: any failure, timeout, or non-object result yields `null`, which
 * the caller treats as "no tool context" (a missing `context.*` key then fails
 * closed at evaluation).
 */
const fetchContextTool = async (args: {
  projectId: number;
  guardrailId: string;
  contextToolId: string;
  call: GuardrailProposedCall;
  authHeader?: string;
}): Promise<Record<string, unknown> | null> => {
  try {
    const raw = await withTimeout(
      callTool({
        // A guardrail's own context fetch: gating it would run the guardrails
        // that decide this call in order to decide this call.
        guardrails: 'already-adjudicated',
        projectIds: [args.projectId],
        id: args.contextToolId,
        // Nested, never flat: a `builtin` tool with no explicit action reads a
        // top-level `action` off its input as the operation to run.
        input: { call: args.call },
        authHeader: args.authHeader,
        attribution: {},
      }),
      contextToolTimeoutMs()
    );
    return isPlainObject(raw) ? raw : null;
  } catch (error) {
    log(
      'fetchContextTool: failed guardrail=%s tool=%s %o',
      args.guardrailId,
      args.contextToolId,
      error
    );
    return null;
  }
};

/**
 * Builds the effective `context.*` for one guardrail: the caller-supplied
 * `guardrail_context` combined with its `context_tool` output per `context_mode`
 * (`merge` — shallow, tool wins; or `replace` — tool substitutes). Returns the
 * effective object and the `context_source` for the audit record.
 */
export const resolveEffectiveContext = async (args: {
  guardrail: CollectedGuardrail;
  callerContext: Record<string, unknown>;
  call: GuardrailProposedCall;
  projectId: number;
  authHeader?: string;
}): Promise<{
  context: Record<string, unknown>;
  source: GuardrailContextSource;
}> => {
  const hasCaller = Object.keys(args.callerContext).length > 0;

  if (!args.guardrail.contextToolId) {
    return {
      context: args.callerContext,
      source: hasCaller ? 'caller' : 'none',
    };
  }

  const toolContext = await fetchContextTool({
    projectId: args.projectId,
    guardrailId: args.guardrail.guardrailId,
    contextToolId: args.guardrail.contextToolId,
    call: args.call,
    authHeader: args.authHeader,
  });

  if (toolContext === null) {
    // Tool failed / timed out — fail closed to the caller context only.
    return {
      context: args.callerContext,
      source: hasCaller ? 'caller' : 'none',
    };
  }

  if (args.guardrail.contextMode === 'replace') {
    return { context: toolContext, source: 'tool' };
  }
  // merge (default): shallow, tool wins on conflict.
  return {
    context: { ...args.callerContext, ...toolContext },
    source: hasCaller ? 'merged' : 'tool',
  };
};

/**
 * The flat `context_snapshot` for one evaluation: only the vars this guardrail's
 * `class` / `guard` expressions referenced, keyed by fully-qualified path and
 * frozen at their evaluation-time values (a missing path snapshots as `null`).
 */
export const buildContextSnapshot = (args: {
  guardrail: CollectedGuardrail;
  evaluationContext: GuardrailEvaluationContext;
}): Record<string, unknown> => {
  const root = {
    args: args.evaluationContext.args ?? {},
    context: args.evaluationContext.context ?? {},
    runtime: args.evaluationContext.runtime ?? {},
  };
  const snapshot: Record<string, unknown> = {};
  for (const path of collectDocumentVarPaths(args.guardrail.document)) {
    const value = getByPath(root, path);
    snapshot[path] = value === undefined ? null : value;
  }
  return snapshot;
};

/**
 * The union of `runtime.*` var paths referenced across every applying guardrail,
 * minus the per-guardrail `runtime.guardrails.*` keys ({@link runtimeForGuardrail})
 * — the set {@link buildGuardrailRuntimeContext} computes once for the call
 * (nothing else is populated, keeping usage queries to only what a guard reads).
 */
export const referencedRuntimePaths = (
  guardrails: CollectedGuardrail[]
): string[] => {
  const paths = new Set<string>();
  for (const guardrail of guardrails) {
    for (const path of collectDocumentVarPaths(guardrail.document)) {
      if (path.startsWith('runtime.') && !isGuardrailScopedPath(path)) {
        paths.add(path);
      }
    }
  }
  return [...paths];
};
