import { DomainError } from '../errors';
import { isLogic } from './jsonLogicMapping';

/**
 * Guardrail action classes (see the guardrails module docs):
 *   A — read-only / harmless (always execute)
 *   B — autonomous with a guard (execute iff the guard passes)
 *   C — human sign-off (files an approval item)
 *   D — forbidden (blocked at dispatch)
 */
export const ACTION_CLASSES = ['A', 'B', 'C', 'D'] as const;

export type ActionClass = (typeof ACTION_CLASSES)[number];

/** Fail-closed default: anything nobody classified requires a human. */
export const DEFAULT_ACTION_CLASS: ActionClass = 'C';

export type GuardrailDocument = {
  class: ActionClass | Record<string, unknown>;
  default_class?: ActionClass;
  guard?: Record<string, unknown>;
  escalate?: boolean;
  // Default approval window (seconds) for a class-C approval this guardrail
  // files. Absent → the platform's 24h default. Lets a guardrail carry its own
  // sign-off deadline (e.g. 72h for a budget change) without a separate
  // taxonomy; the governing guardrail's value wins when several apply.
  expires_in?: number;
};

const DOCUMENT_KEYS = [
  'class',
  'default_class',
  'guard',
  'escalate',
  'expires_in',
];

/**
 * The fixed `soat.*` catalog. A `soat.*` variable outside this set is rejected
 * at write time rather than resolving to `null` at evaluation time. Windows are
 * baked into the key name (`_1h` / `_24h` / `_7d` / `_30d`). Keep in sync with
 * the catalog table in `packages/website/docs/modules/guardrails.md`.
 */
export const SOAT_CONTEXT_CATALOG: ReadonlySet<string> = new Set([
  'soat.action',
  'soat.tool.id',
  'soat.tool.name',
  'soat.agent.id',
  'soat.project.id',
  'soat.run.node_attempt',
  'soat.run.tool_calls',
  'soat.activity.actions_1h',
  'soat.activity.actions_24h',
  'soat.usage.cost_usd_1h',
  'soat.usage.cost_usd_24h',
  'soat.usage.cost_usd_7d',
  'soat.usage.cost_usd_30d',
  'soat.usage.tokens_24h',
  'soat.usage.tokens_30d',
]);

export const isActionClass = (value: unknown): value is ActionClass => {
  return (
    typeof value === 'string' &&
    (ACTION_CLASSES as readonly string[]).includes(value)
  );
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

// The path a JSON Logic `var` argument selects: a bare string, or the first
// element of a `[path, default]` array. A non-string argument selects nothing
// resolvable and so needs no write-time rule (it fails closed at runtime).
const varArgPath = (arg: unknown): string | undefined => {
  if (typeof arg === 'string') return arg;
  if (Array.isArray(arg) && typeof arg[0] === 'string') return arg[0];
  return undefined;
};

/**
 * Collects every JSON Logic `var` path referenced anywhere in an expression, at
 * any nesting depth (inside operator arrays, inside a `var` default value).
 */
const collectVarPaths = (node: unknown, out: string[]): void => {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectVarPaths(item, out);
    }
    return;
  }
  if (!isPlainObject(node)) {
    return;
  }
  const keys = Object.keys(node);
  if (keys.length === 1 && keys[0] === 'var') {
    const path = varArgPath(node.var);
    if (path !== undefined) {
      out.push(path);
    }
    // Recurse into the argument so a var default that itself contains vars
    // (`{ var: [path, { var: '...' }] }`) is captured too.
    collectVarPaths(node.var, out);
    return;
  }
  for (const value of Object.values(node)) {
    collectVarPaths(value, out);
  }
};

/**
 * Every JSON Logic `var` path referenced by a document's `class` and `guard`
 * expressions, de-duplicated and in first-seen order. This is the exact set the
 * evaluation audit record snapshots (guardrails.md — Evaluation Audit Record):
 * only the vars an expression actually read, keyed by fully-qualified path. A
 * literal `class` (no expression) contributes nothing.
 */
export const collectDocumentVarPaths = (
  document: GuardrailDocument
): string[] => {
  const paths: string[] = [];
  if (isPlainObject(document.class)) {
    collectVarPaths(document.class, paths);
  }
  if (isPlainObject(document.guard)) {
    collectVarPaths(document.guard, paths);
  }
  return [...new Set(paths)];
};

const isAllowedVarPath = (path: string): boolean => {
  if (path === 'args' || path.startsWith('args.')) return true;
  if (path === 'context' || path.startsWith('context.')) return true;
  return SOAT_CONTEXT_CATALOG.has(path);
};

const assertVarNamespaces = (expression: unknown, field: string): void => {
  const paths: string[] = [];
  collectVarPaths(expression, paths);
  for (const path of paths) {
    if (isAllowedVarPath(path)) continue;
    const detail = path.startsWith('soat.')
      ? `'${path}' is not in the soat.* catalog`
      : `'${path}' is outside the args.* / context.* / soat.* namespaces`;
    throw new DomainError(
      'VALIDATION_FAILED',
      `Guardrail ${field} expression references an unknown variable: ${detail}.`,
      { field, var: path }
    );
  }
};

const assertKnownKeys = (document: Record<string, unknown>): void => {
  for (const key of Object.keys(document)) {
    if (!DOCUMENT_KEYS.includes(key)) {
      throw new DomainError(
        'VALIDATION_FAILED',
        `Guardrail document has an unknown field '${key}'. Allowed fields: ${DOCUMENT_KEYS.join(', ')}.`,
        { field: key }
      );
    }
  }
};

const validateClassField = (klass: unknown): void => {
  if (typeof klass === 'string') {
    if (!isActionClass(klass)) {
      throw new DomainError(
        'VALIDATION_FAILED',
        `Guardrail 'class' literal must be one of ${ACTION_CLASSES.join(' / ')}.`
      );
    }
    return;
  }
  if (isLogic(klass)) {
    assertVarNamespaces(klass, 'class');
    return;
  }
  throw new DomainError(
    'VALIDATION_FAILED',
    "Guardrail 'class' must be a class literal (A/B/C/D) or a JSON Logic expression."
  );
};

const validateGuardField = (document: Record<string, unknown>): void => {
  if (!('guard' in document) || document.guard === undefined) {
    return;
  }
  if (!isLogic(document.guard)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      "Guardrail 'guard' must be a JSON Logic expression."
    );
  }
  assertVarNamespaces(document.guard, 'guard');
};

const validateOptionalFields = (document: Record<string, unknown>): void => {
  if ('default_class' in document && !isActionClass(document.default_class)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `Guardrail 'default_class' must be one of ${ACTION_CLASSES.join(' / ')}.`
    );
  }
  validateGuardField(document);
  if ('escalate' in document && typeof document.escalate !== 'boolean') {
    throw new DomainError(
      'VALIDATION_FAILED',
      "Guardrail 'escalate' must be a boolean."
    );
  }
  if (
    'expires_in' in document &&
    (typeof document.expires_in !== 'number' ||
      !Number.isInteger(document.expires_in) ||
      document.expires_in <= 0)
  ) {
    throw new DomainError(
      'VALIDATION_FAILED',
      "Guardrail 'expires_in' must be a positive integer (seconds)."
    );
  }
};

/**
 * Validates a guardrail document against the `{ class, default_class, guard?,
 * escalate? }` contract and the fail-closed variable rules. Throws
 * `DomainError('VALIDATION_FAILED', ...)` on any violation so the route handler
 * returns `400`. Pure — no database or evaluation, safe to call on every write.
 */
export const validateGuardrailDocument = (document: unknown): void => {
  if (!isPlainObject(document)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'Guardrail document must be a JSON object.'
    );
  }

  assertKnownKeys(document);

  if (!('class' in document)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      "Guardrail document is missing the required 'class' field."
    );
  }

  validateClassField(document.class);
  validateOptionalFields(document);
};
