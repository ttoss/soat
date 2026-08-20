import createDebug from 'debug';

import { db } from '../db';
import { windowedActionCount } from './activity';
import type { CollectedGuardrail } from './guardrailCollection';
import { collectDocumentVarPaths } from './guardrailDocument';
import type { GuardrailEvaluationContext } from './guardrailEvaluation';
import { isPlainObject } from './plainObject';
import { callTool } from './tools';
import {
  runCostUsd,
  runTokens,
  windowedCostUsd,
  windowedTokens,
} from './usageThresholds';

const log = createDebug('soat:guardrails');

// How the effective `context.*` was produced for one guardrail evaluation —
// recorded on the audit record (guardrails.md — Evaluation Audit Record).
export type GuardrailContextSource = 'caller' | 'tool' | 'merged' | 'none';

/** Orchestration-run state feeding `runtime.run.*`; absent for plain generations. */
export type SoatRunContext = {
  nodeAttempt?: number | null;
  toolCalls?: number | null;
};

/** The identity + call inputs every `runtime.*` / snapshot resolution reads from. */
export type GuardrailCallIdentity = {
  projectId: number;
  projectPublicId: string;
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

// Sets a dotted path (`usage.cost_usd_24h`) into a nested object, creating
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

const WINDOW_MS: Record<string, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

// Deterministic, synchronous `runtime.*` values (identity + run state). The nested
// shape mirrors the dotted catalog keys so `{ var: 'runtime.tool.id' }` resolves.
const buildDeterministicRuntime = (
  identity: GuardrailCallIdentity
): Record<string, unknown> => {
  return {
    action: identity.action ?? null,
    tool: { id: identity.toolId ?? null, name: identity.toolName ?? null },
    agent: { id: identity.agentId ?? null },
    project: { id: identity.projectPublicId },
    run: {
      node_attempt: identity.run?.nodeAttempt ?? null,
      tool_calls: identity.run?.toolCalls ?? null,
    },
  };
};

// Distinguishes "leave the key unset" (→ null → fail-closed) from a resolved
// `null`, which a failed query writes explicitly.
const UNRESOLVED = Symbol('unresolved');

const RUN_USAGE_KEYS = new Set(['usage.run_tokens', 'usage.run_cost_usd']);

// Resolves the call's run public id to its internal id, at most once per
// evaluation: the two run keys share the lookup, and a guard referencing
// neither must not pay for it.
const memoizedRunResolver = (
  identity: GuardrailCallIdentity
): (() => Promise<number | null>) => {
  let cached: number | null | undefined;
  return async () => {
    if (cached !== undefined) return cached;
    if (!identity.orchestrationRunId) {
      cached = null;
      return cached;
    }
    const run = await db.OrchestrationRun.findOne({
      where: {
        publicId: identity.orchestrationRunId,
        projectId: identity.projectId,
      },
      attributes: ['id'],
    });
    cached = (run?.id as number | undefined) ?? null;
    return cached;
  };
};

// `runtime.usage.run_*` — the current run's cumulative metered spend. Outside a
// run there is nothing to accumulate against, so the key is left unresolved
// (→ fail-closed) rather than reading as 0 and letting a ceiling pass.
const resolveRunUsage = async (args: {
  rel: string;
  path: string;
  resolveRun: () => Promise<number | null>;
}): Promise<number | null | typeof UNRESOLVED> => {
  try {
    const runInternalId = await args.resolveRun();
    if (runInternalId === null) return UNRESOLVED;
    return args.rel === 'usage.run_cost_usd'
      ? await runCostUsd({ runInternalId })
      : await runTokens({ runInternalId });
  } catch (error) {
    log(
      'buildGuardrailRuntimeContext: run usage failed path=%s %o',
      args.path,
      error
    );
    return null;
  }
};

// `runtime.usage.cost_usd_*` / `tokens_*` — the project's rolling window ending
// now. An unknown window suffix is left unresolved.
const resolveWindowedUsage = async (args: {
  rel: string;
  path: string;
  projectId: number;
  now: Date;
}): Promise<number | null | typeof UNRESOLVED> => {
  const key = args.rel.slice('usage.'.length);
  const ms = WINDOW_MS[key.slice(key.lastIndexOf('_') + 1)];
  if (ms === undefined) return UNRESOLVED;
  const start = new Date(args.now.getTime() - ms);
  try {
    return key.startsWith('cost_usd_')
      ? await windowedCostUsd({ projectId: args.projectId, start })
      : await windowedTokens({ projectId: args.projectId, start });
  } catch (error) {
    log(
      'buildGuardrailRuntimeContext: usage failed path=%s %o',
      args.path,
      error
    );
    return null;
  }
};

// `runtime.activity.actions_*` — how many actions this project executed
// autonomously in the rolling window ending now, read off the activity feed. An
// empty feed is a real 0 (not unresolved), so a rate ceiling passes for a
// project that has taken no actions yet. An unknown window suffix is left
// unresolved.
const resolveWindowedActivity = async (args: {
  rel: string;
  path: string;
  projectId: number;
  now: Date;
}): Promise<number | null | typeof UNRESOLVED> => {
  const key = args.rel.slice('activity.'.length);
  if (!key.startsWith('actions_')) return UNRESOLVED;
  const ms = WINDOW_MS[key.slice(key.lastIndexOf('_') + 1)];
  if (ms === undefined) return UNRESOLVED;
  const start = new Date(args.now.getTime() - ms);
  try {
    return await windowedActionCount({ projectId: args.projectId, start });
  } catch (error) {
    log(
      'buildGuardrailRuntimeContext: activity failed path=%s %o',
      args.path,
      error
    );
    return null;
  }
};

// Dispatches one referenced catalog key to the namespace that computes it. A key
// outside these namespaces is either already set by `buildDeterministicRuntime` or
// one we don't compute — returning UNRESOLVED leaves it unset, so it reads as
// null → fail-closed.
const resolveAsyncRuntimeKey = (args: {
  rel: string;
  path: string;
  projectId: number;
  now: Date;
  resolveRun: () => Promise<number | null>;
}): Promise<number | null | typeof UNRESOLVED> => {
  const { rel, path, projectId, now } = args;
  if (rel.startsWith('activity.')) {
    return resolveWindowedActivity({ rel, path, projectId, now });
  }
  if (!rel.startsWith('usage.')) {
    return Promise.resolve(UNRESOLVED);
  }
  return RUN_USAGE_KEYS.has(rel)
    ? resolveRunUsage({ rel, path, resolveRun: args.resolveRun })
    : resolveWindowedUsage({ rel, path, projectId, now });
};

/**
 * Populates the `runtime.*` namespace for a call, filling **only** the catalog keys
 * the applying guardrails actually reference (`referencedRuntimePaths`). Identity
 * and run keys are synchronous; `runtime.usage.cost_usd_*` / `tokens_*` sum the
 * project's windowed usage at evaluation time; `runtime.usage.run_tokens` /
 * `run_cost_usd` sum only the current orchestration run's meters so far, so a
 * per-run ceiling can abort one runaway run mid-flight; `runtime.activity.actions_*`
 * count the project's executed actions over the same rolling windows, off the
 * activity feed. Fail-closed throughout: a usage or activity query that throws,
 * or a run key read outside a run, leaves the key `null`.
 */
export const buildGuardrailRuntimeContext = async (args: {
  identity: GuardrailCallIdentity;
  referencedRuntimePaths: string[];
  now: Date;
}): Promise<Record<string, unknown>> => {
  const runtime = buildDeterministicRuntime(args.identity);
  const resolveRun = memoizedRunResolver(args.identity);

  for (const path of args.referencedRuntimePaths) {
    // path is like 'runtime.usage.cost_usd_24h' — strip the leading namespace.
    const rel = path.startsWith('runtime.')
      ? path.slice('runtime.'.length)
      : path;
    const value = await resolveAsyncRuntimeKey({
      rel,
      path,
      projectId: args.identity.projectId,
      now: args.now,
      resolveRun,
    });
    if (value !== UNRESOLVED) setByPath(runtime, rel, value);
  }

  return runtime;
};

// ── Per-guardrail context tool ───────────────────────────────────────────────

const DEFAULT_CONTEXT_TOOL_TIMEOUT_MS = 5000;
// A short per-(project, guardrail) cache so a long tool-calling turn doesn't
// re-fetch the same context for every gated call.
const CONTEXT_TOOL_TTL_MS = 5000;

// Read per call so operators (and tests) can tune the context-tool timeout via
// SOAT_GUARDRAIL_CONTEXT_TIMEOUT_MS without a restart-time capture.
const contextToolTimeoutMs = (): number => {
  const raw = Number(process.env.SOAT_GUARDRAIL_CONTEXT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_CONTEXT_TOOL_TIMEOUT_MS;
};

type CacheEntry = { value: Record<string, unknown> | null; expiresAt: number };
const contextToolCache = new Map<string, CacheEntry>();

// Exposed for tests to reset the module-level cache between cases.
export const clearGuardrailContextToolCache = (): void => {
  contextToolCache.clear();
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
 * for the `context.*` namespace. Bounded by a per-call timeout and cached per
 * `(project, guardrail)` for a short TTL. Fail-closed: any failure, timeout, or
 * non-object result yields `null`, which the caller treats as "no tool context"
 * (a missing `context.*` key then fails closed at evaluation).
 */
const fetchContextTool = async (args: {
  projectId: number;
  guardrailId: string;
  contextToolId: string;
  authHeader?: string;
  now: Date;
}): Promise<Record<string, unknown> | null> => {
  const cacheKey = `${args.projectId}:${args.guardrailId}`;
  const cached = contextToolCache.get(cacheKey);
  if (cached && cached.expiresAt > args.now.getTime()) {
    return cached.value;
  }

  let value: Record<string, unknown> | null = null;
  try {
    const raw = await withTimeout(
      callTool({
        projectIds: [args.projectId],
        id: args.contextToolId,
        input: {},
        authHeader: args.authHeader,
      }),
      contextToolTimeoutMs()
    );
    value = isPlainObject(raw) ? raw : null;
  } catch (error) {
    log(
      'fetchContextTool: failed guardrail=%s tool=%s %o',
      args.guardrailId,
      args.contextToolId,
      error
    );
    value = null;
  }

  contextToolCache.set(cacheKey, {
    value,
    expiresAt: args.now.getTime() + CONTEXT_TOOL_TTL_MS,
  });
  return value;
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
  projectId: number;
  authHeader?: string;
  now: Date;
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
    authHeader: args.authHeader,
    now: args.now,
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
 * The union of `runtime.*` var paths referenced across every applying guardrail —
 * the set {@link buildGuardrailRuntimeContext} needs to compute (nothing else is
 * populated, keeping usage queries to only what a guard reads).
 */
export const referencedRuntimePaths = (
  guardrails: CollectedGuardrail[]
): string[] => {
  const paths = new Set<string>();
  for (const guardrail of guardrails) {
    for (const path of collectDocumentVarPaths(guardrail.document)) {
      if (path === 'runtime' || path.startsWith('runtime.')) {
        paths.add(path);
      }
    }
  }
  return [...paths];
};
