import createDebug from 'debug';

import type { CollectedGuardrail } from './guardrailCollection';
import { collectDocumentVarPaths } from './guardrailDocument';
import type { GuardrailEvaluationContext } from './guardrailEvaluation';
import { withCaseAliases } from './guardrailEvaluation';
import { callTool } from './tools';
import { windowedCostUsd, windowedTokens } from './usageThresholds';

const log = createDebug('soat:guardrails');

// How the effective `context.*` was produced for one guardrail evaluation —
// recorded on the audit record (guardrails.md — Evaluation Audit Record).
export type GuardrailContextSource = 'caller' | 'tool' | 'merged' | 'none';

/** Orchestration-run state feeding `soat.run.*`; absent for plain generations. */
export type SoatRunContext = {
  nodeAttempt?: number | null;
  toolCalls?: number | null;
};

/** The identity + call inputs every `soat.*` / snapshot resolution reads from. */
export type GuardrailCallIdentity = {
  projectId: number;
  projectPublicId: string;
  agentId?: string | null;
  toolId?: string | null;
  toolName?: string | null;
  action?: string | null;
  runId?: string | null;
  run?: SoatRunContext | null;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

// Deterministic, synchronous `soat.*` values (identity + run state). The nested
// shape mirrors the dotted catalog keys so `{ var: 'soat.tool.id' }` resolves.
const buildDeterministicSoat = (
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

/**
 * Populates the `soat.*` namespace for a call, filling **only** the catalog keys
 * the applying guardrails actually reference (`referencedSoatPaths`). Identity
 * and run keys are synchronous; `soat.usage.*` sums the project's windowed usage
 * at evaluation time; `soat.activity.*` stays unresolvable (`null`) until the
 * activity feed is populated (task 5.4) — a guard referencing it fails closed.
 * Fail-closed throughout: a usage query that throws leaves the key `null`.
 */
export const buildGuardrailSoatContext = async (args: {
  identity: GuardrailCallIdentity;
  referencedSoatPaths: string[];
  now: Date;
}): Promise<Record<string, unknown>> => {
  const soat = buildDeterministicSoat(args.identity);

  for (const path of args.referencedSoatPaths) {
    // path is like 'soat.usage.cost_usd_24h' — strip the leading namespace.
    const rel = path.startsWith('soat.') ? path.slice('soat.'.length) : path;
    if (rel.startsWith('usage.')) {
      const key = rel.slice('usage.'.length);
      const window = key.slice(key.lastIndexOf('_') + 1);
      const ms = WINDOW_MS[window];
      if (ms === undefined) continue;
      const start = new Date(args.now.getTime() - ms);
      try {
        const value = key.startsWith('cost_usd_')
          ? await windowedCostUsd({ projectId: args.identity.projectId, start })
          : await windowedTokens({ projectId: args.identity.projectId, start });
        setByPath(soat, rel, value);
      } catch (error) {
        log(
          'buildGuardrailSoatContext: usage query failed path=%s %o',
          path,
          error
        );
        setByPath(soat, rel, null);
      }
    }
    // activity.* and any other catalog key we don't yet compute are left unset
    // → resolves to null → fail-closed.
  }

  return soat;
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
  // Case-alias args/context exactly as buildLogicContext does, so a snake_case
  // var path snapshots the value it actually resolved to at evaluation time
  // (rather than a spurious null) when the runtime key was camelCased.
  const root = {
    args: withCaseAliases(args.evaluationContext.args ?? {}),
    context: withCaseAliases(args.evaluationContext.context ?? {}),
    soat: args.evaluationContext.soat ?? {},
  };
  const snapshot: Record<string, unknown> = {};
  for (const path of collectDocumentVarPaths(args.guardrail.document)) {
    const value = getByPath(root, path);
    snapshot[path] = value === undefined ? null : value;
  }
  return snapshot;
};

/**
 * The union of `soat.*` var paths referenced across every applying guardrail —
 * the set {@link buildGuardrailSoatContext} needs to compute (nothing else is
 * populated, keeping usage queries to only what a guard reads).
 */
export const referencedSoatPaths = (
  guardrails: CollectedGuardrail[]
): string[] => {
  const paths = new Set<string>();
  for (const guardrail of guardrails) {
    for (const path of collectDocumentVarPaths(guardrail.document)) {
      if (path === 'soat' || path.startsWith('soat.')) {
        paths.add(path);
      }
    }
  }
  return [...paths];
};
