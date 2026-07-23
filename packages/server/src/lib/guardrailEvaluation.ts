import createDebug from 'debug';

import type { ActionClass, GuardrailDocument } from './guardrailDocument';
import {
  collectExpressionVarPaths,
  DEFAULT_ACTION_CLASS,
  isActionClass,
} from './guardrailDocument';
import { evaluateLogic } from './jsonLogicMapping';

const log = createDebug('soat:guardrails');

/**
 * The enacted outcome of evaluating a guardrail against one tool call. Ordered
 * from most to least strict — composition takes the strictest across every
 * applying guardrail (guardrails.md — Attachment):
 *
 *   blocked            — class D; the call never reaches the outside world
 *   tripwire           — a class-B guard failed with no `escalate`; hard stop
 *   route_to_approval  — class C, or a failing class-B guard with `escalate`
 *   execute            — class A, or a class-B guard that passed
 */
export type GuardrailDecision =
  'execute' | 'route_to_approval' | 'tripwire' | 'blocked';

/** Where a guardrail was attached — one record is emitted per scope. */
export type GuardrailScope = 'project' | 'agent' | 'tool';

/**
 * The three variable namespaces a `class` / `guard` expression reads over. Each
 * is optional; a missing namespace (or a missing key within one) resolves to
 * `null` and so fails closed — the invariant guards depend on.
 */
export type GuardrailEvaluationContext = {
  args?: Record<string, unknown>;
  context?: Record<string, unknown>;
  soat?: Record<string, unknown>;
};

/** A guardrail resolved for a call, tagged with the scope it was attached at. */
export type AttachedGuardrail = {
  guardrailId: string;
  version: number;
  scope: GuardrailScope;
  document: GuardrailDocument;
};

/** The per-guardrail evaluation outcome (one is written per applying guardrail). */
export type GuardrailEvaluationResult = {
  guardrailId: string;
  version: number;
  scope: GuardrailScope;
  class: ActionClass;
  decision: GuardrailDecision;
  // The guard expression's boolean outcome; `null` when the class was not B
  // (no guard was evaluated).
  guardResult: boolean | null;
};

export type ComposedGuardrailDecision = {
  decision: GuardrailDecision;
  evaluations: GuardrailEvaluationResult[];
};

const DECISION_RANK: Record<GuardrailDecision, number> = {
  execute: 0,
  route_to_approval: 1,
  tripwire: 2,
  blocked: 3,
};

/** Returns the stricter of two decisions (ties keep the first). */
export const strictestDecision = (
  a: GuardrailDecision,
  b: GuardrailDecision
): GuardrailDecision => {
  return DECISION_RANK[b] > DECISION_RANK[a] ? b : a;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

// Builds the nested object the JSON Logic evaluator reads `var` dot-paths
// against — `{ var: 'args.amount' }` selects `args.amount`, etc. The caller's
// `args` / `guardrail_context` are opaque, application-owned bags whose keys the
// caseTransform middleware leaves verbatim (see its guardrail pass-through), so a
// `var` path resolves against exactly the casing the author wrote — matching how
// tool `input`, task `payload`, and orchestration-run `input` are read back.
// Every namespace defaults to an empty object so an absent one resolves to `null`
// (fail-closed) rather than surfacing as an evaluator error.
const buildLogicContext = (context: GuardrailEvaluationContext) => {
  return {
    args: context.args ?? {},
    context: context.context ?? {},
    soat: context.soat ?? {},
  };
};

// Reads a dotted path (`soat.activity.actions_24h`) off the logic context,
// returning `undefined` when any segment is missing.
const getByPath = (root: unknown, path: string): unknown => {
  let node: unknown = root;
  for (const segment of path.split('.')) {
    if (!isPlainObject(node)) return undefined;
    node = node[segment];
  }
  return node;
};

/**
 * Whether `expression` references a `soat.*` or `context.*` var path that is
 * currently unresolvable (missing or explicitly `null`). This is the fail-
 * closed check the docs promise for those two namespaces: an unresolvable
 * catalog key or context-tool output must not silently pass a `class`/`guard`
 * expression just because JSON Logic coerces `null` to a zero-ish value for
 * numeric comparisons (`null < 100` → `true`). `args.*` is deliberately
 * excluded — its `null`-coercion behavior is documented as expected, existing
 * behavior the caller is told to guard against explicitly, not a fail-closed
 * invariant to enforce here.
 */
const hasUnresolvedFailClosedVar = (
  expression: unknown,
  logicContext: Record<string, unknown>
): boolean => {
  return collectExpressionVarPaths(expression).some((path) => {
    const isFailClosedNamespace =
      path === 'soat' ||
      path.startsWith('soat.') ||
      path === 'context' ||
      path.startsWith('context.');
    if (!isFailClosedNamespace) return false;
    const value = getByPath(logicContext, path);
    return value === null || value === undefined;
  });
};

/**
 * Resolves the action class for a call. A literal `class` is returned directly;
 * a JSON Logic `class` expression is evaluated and its result kept only if it is
 * a valid class. Anything else — a missing key (`null`), a typo, a number, an
 * evaluator error, or a reference to an unresolvable `soat.*`/`context.*` var —
 * resolves to `default_class`, itself defaulting to `C` (fail-closed): a
 * misconfigured or under-resolved classification never grants autonomy.
 */
const resolveClass = (
  document: GuardrailDocument,
  logicContext: Record<string, unknown>
): ActionClass => {
  if (isActionClass(document.class)) {
    return document.class;
  }
  let result: unknown = null;
  try {
    if (
      isPlainObject(document.class) &&
      hasUnresolvedFailClosedVar(document.class, logicContext)
    ) {
      result = null;
    } else {
      result = evaluateLogic(document.class, logicContext);
    }
  } catch {
    result = null;
  }
  if (isActionClass(result)) {
    return result;
  }
  return isActionClass(document.default_class)
    ? document.default_class
    : DEFAULT_ACTION_CLASS;
};

/**
 * Whether a class-B call's guard passes. A B with no guard expression fails
 * closed (nothing to pass); an evaluator error, or a reference to an
 * unresolvable `soat.*`/`context.*` var, counts as a failed guard — forgetting
 * to supply context tightens the posture, never loosens it. The unresolved-var
 * check runs *before* evaluation so a comparison operator's `null → 0`
 * coercion (`{ "<": [{ "var": "soat.activity.actions_24h" }, 100] }` passing
 * while the activity feed is dark) can never flip an unresolvable reference
 * into a passing guard. Plain JS truthiness matches the JSON Logic convention
 * used elsewhere in the server.
 */
const guardPasses = (
  document: GuardrailDocument,
  logicContext: Record<string, unknown>
): boolean => {
  if (!isPlainObject(document.guard)) {
    return false;
  }
  if (hasUnresolvedFailClosedVar(document.guard, logicContext)) {
    return false;
  }
  try {
    return Boolean(evaluateLogic(document.guard, logicContext));
  } catch {
    return false;
  }
};

/**
 * Evaluates one guardrail against a call: resolves the class, then maps it to a
 * decision. Class A → execute, D → blocked, C → route_to_approval; class B
 * executes iff its guard passes, otherwise trips (or routes to approval when
 * the document opts into `escalate`).
 */
export const evaluateGuardrail = (args: {
  guardrail: AttachedGuardrail;
  context: GuardrailEvaluationContext;
}): GuardrailEvaluationResult => {
  const { guardrail } = args;
  const logicContext = buildLogicContext(args.context);
  const klass = resolveClass(guardrail.document, logicContext);

  const base = {
    guardrailId: guardrail.guardrailId,
    version: guardrail.version,
    scope: guardrail.scope,
    class: klass,
  };

  if (klass === 'A') {
    return { ...base, decision: 'execute', guardResult: null };
  }
  if (klass === 'D') {
    return { ...base, decision: 'blocked', guardResult: null };
  }
  if (klass === 'C') {
    return { ...base, decision: 'route_to_approval', guardResult: null };
  }

  // Class B — gated by the guard.
  const guardResult = guardPasses(guardrail.document, logicContext);
  if (guardResult) {
    return { ...base, decision: 'execute', guardResult: true };
  }
  const decision: GuardrailDecision =
    guardrail.document.escalate === true ? 'route_to_approval' : 'tripwire';
  return { ...base, decision, guardResult: false };
};

/**
 * Evaluates every guardrail applying to a call and returns the strictest
 * decision across them (guardrails.md — Attachment). Composition is
 * order-independent and can only tighten: `A` is the identity, and the
 * guards-AND rule falls out of stricter-wins — any failing class-B guard yields
 * `tripwire` / `route_to_approval`, which outranks another guardrail's `execute`.
 * An empty set means no guardrail gates the call, so it executes.
 */
export const composeGuardrailDecision = (args: {
  guardrails: AttachedGuardrail[];
  context: GuardrailEvaluationContext;
}): ComposedGuardrailDecision => {
  const evaluations = args.guardrails.map((guardrail) => {
    return evaluateGuardrail({ guardrail, context: args.context });
  });

  const decision = evaluations.reduce<GuardrailDecision>((acc, evaluation) => {
    return strictestDecision(acc, evaluation.decision);
  }, 'execute');

  log(
    'composeGuardrailDecision: guardrails=%d decision=%s',
    args.guardrails.length,
    decision
  );

  return { decision, evaluations };
};
