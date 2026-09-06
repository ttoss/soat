import createDebug from 'debug';

import { db } from '../db';
import { isPlainObject } from './plainObject';

const log = createDebug('soat:usage');

/**
 * One-time rewrite of the stored documents that carry a name #1216 renamed.
 *
 * Both validators behind those names — `isKnownAction` for policy actions,
 * `RUNTIME_CONTEXT_CATALOG` for guardrail variables — run at authoring time
 * only, so a document a tenant stored before this release keeps its old
 * strings and the release silently changes what they do: an `Allow` grants
 * nothing and a `Deny` denies nothing (fail-open), while an unresolvable
 * guardrail variable makes `guardPasses` fail every call (fail-closed, an
 * outage for that agent).
 *
 * Idempotent and prefiltered in SQL, so a converged database reads no rows and
 * it is safe to leave wired into every boot. The rewrite touches only names
 * the platform owns, enumerated below — never a string a tenant wrote.
 */

/** IAM actions renamed by §3 and §4. Wildcards (`usage:*`) are untouched. */
const RENAMED_ACTIONS: Record<string, string> = {
  'usage:ListUsageMeters': 'usage:ListEvents',
  'usage:GetUsage': 'usage:GetAggregate',
};

/** Guardrail `runtime.*` variables renamed by §2. */
const RENAMED_VAR_PATHS: Record<string, string> = {
  'runtime.usage.run_tokens': 'runtime.usage.orchestration_run_tokens',
  'runtime.usage.run_cost_usd': 'runtime.usage.orchestration_run_cost_usd',
  'runtime.run.node_attempt': 'runtime.orchestration_run.node_attempt',
  'runtime.run.tool_calls': 'runtime.orchestration_run.tool_calls',
};

// No new name contains an old one, so a rewritten row stops matching and the
// prefilter converges. The needles are literals with no quote to escape.
const containsAny = (args: { column: string; needles: string[] }): string => {
  return args.needles
    .map((needle) => {
      return `strpos(${args.column}::text, '${needle}') > 0`;
    })
    .join(' OR ');
};

const ACTION_PREFILTER = containsAny({
  column: '"document"',
  needles: Object.keys(RENAMED_ACTIONS),
});

const varPrefilter = (column: string): string => {
  return containsAny({ column, needles: Object.keys(RENAMED_VAR_PATHS) });
};

type Rewritten = { value: unknown; changed: boolean };

const isVarNode = (node: Record<string, unknown>): boolean => {
  const keys = Object.keys(node);
  return keys.length === 1 && keys[0] === 'var';
};

/**
 * A `var` node with its path renamed, in both forms the argument takes: a bare
 * string, and the first element of `[path, default]`. Non-recursive — the
 * argument's own contents are walked by the caller, so a default that itself
 * holds a `var` is still reached.
 */
const renameVarNode = (node: Record<string, unknown>): Rewritten => {
  const arg = node.var;
  if (typeof arg === 'string') {
    const renamed = RENAMED_VAR_PATHS[arg];
    return renamed === undefined
      ? { value: node, changed: false }
      : { value: { var: renamed }, changed: true };
  }
  if (Array.isArray(arg) && typeof arg[0] === 'string') {
    const renamed = RENAMED_VAR_PATHS[arg[0]];
    return renamed === undefined
      ? { value: node, changed: false }
      : { value: { var: [renamed, ...arg.slice(1)] }, changed: true };
  }
  return { value: node, changed: false };
};

/**
 * Rewrites the path of every JSON Logic `var` node in `node`.
 *
 * The node shape is the one `collectVarPaths` walks — an object whose only key
 * is `var` — and the walk descends through every value afterwards, so a `var`
 * at any depth of a `class` or `guard` expression, including one inside
 * another's default, is reached.
 */
const rewriteVarPaths = (node: unknown): Rewritten => {
  if (Array.isArray(node)) {
    let listChanged = false;
    const items = node.map((item) => {
      const rewritten = rewriteVarPaths(item);
      listChanged = listChanged || rewritten.changed;
      return rewritten.value;
    });
    return { value: listChanged ? items : node, changed: listChanged };
  }

  if (!isPlainObject(node)) return { value: node, changed: false };

  const renamed = isVarNode(node)
    ? renameVarNode(node)
    : { value: node, changed: false };
  const current = isPlainObject(renamed.value) ? renamed.value : node;

  let changed = renamed.changed;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(current)) {
    const rewritten = rewriteVarPaths(value);
    changed = changed || rewritten.changed;
    out[key] = rewritten.value;
  }
  return { value: changed ? out : node, changed };
};

const rewriteActionList = (action: unknown): Rewritten => {
  if (typeof action === 'string') {
    const renamed = RENAMED_ACTIONS[action];
    return renamed === undefined
      ? { value: action, changed: false }
      : { value: renamed, changed: true };
  }
  if (!Array.isArray(action)) return { value: action, changed: false };

  let changed = false;
  const actions = action.map((entry) => {
    const rewritten = rewriteActionList(entry);
    changed = changed || rewritten.changed;
    return rewritten.value;
  });
  return { value: changed ? actions : action, changed };
};

/**
 * Returns the rewritten policy document, or `null` when it named no renamed
 * action. Only each statement's `action` is touched — never a `resource`, a
 * `condition` value, or anything else a tenant authored.
 */
export const rewriteStoredPolicyDocument = (
  value: unknown
): Record<string, unknown> | null => {
  if (!isPlainObject(value) || !Array.isArray(value.statement)) return null;

  let changed = false;
  const statement = value.statement.map((entry) => {
    if (!isPlainObject(entry)) return entry;
    const rewritten = rewriteActionList(entry.action);
    if (!rewritten.changed) return entry;
    changed = true;
    return { ...entry, action: rewritten.value };
  });

  return changed ? { ...value, statement } : null;
};

/**
 * Returns the rewritten guardrail document (or version snapshot), or `null`
 * when it referenced no renamed variable.
 */
export const rewriteStoredGuardrailDocument = (
  value: unknown
): Record<string, unknown> | null => {
  if (!isPlainObject(value)) return null;
  const rewritten = rewriteVarPaths(value);
  return rewritten.changed && isPlainObject(rewritten.value)
    ? rewritten.value
    : null;
};

/**
 * Returns the rewritten formation template, or `null` when nothing in it
 * carried a renamed name.
 *
 * Enumerated by resource type rather than walked whole: a `policy` resource's
 * `document` is the only place an action string is the platform's, and a
 * `guardrail` resource flattens `class` / `guard` across its property bag, so
 * the var rewrite reads the bag. Every other resource type is left alone.
 */
const rewriteResourceDeclaration = (declaration: unknown): unknown | null => {
  if (!isPlainObject(declaration) || !isPlainObject(declaration.properties)) {
    return null;
  }

  if (declaration.type === 'policy') {
    const document = rewriteStoredPolicyDocument(
      declaration.properties.document
    );
    return document === null
      ? null
      : {
          ...declaration,
          properties: { ...declaration.properties, document },
        };
  }

  if (declaration.type === 'guardrail') {
    const properties = rewriteStoredGuardrailDocument(declaration.properties);
    return properties === null ? null : { ...declaration, properties };
  }

  return null;
};

export const rewriteStoredFormationTemplate = (
  value: unknown
): Record<string, unknown> | null => {
  if (!isPlainObject(value) || !isPlainObject(value.resources)) return null;

  let changed = false;
  const resources: Record<string, unknown> = {};
  for (const [logicalId, declaration] of Object.entries(value.resources)) {
    const rewritten = rewriteResourceDeclaration(declaration);
    changed = changed || rewritten !== null;
    resources[logicalId] = rewritten ?? declaration;
  }

  return changed ? { ...value, resources } : null;
};

const backfillPolicies = async (): Promise<number> => {
  const policies = await db.Policy.findAll({
    where: db.Policy.sequelize!.literal(ACTION_PREFILTER),
  });

  let updated = 0;
  for (const policy of policies) {
    const document = rewriteStoredPolicyDocument(policy.document);
    if (!document) continue;
    // Reassign the whole column: Sequelize does not track mutations inside a
    // JSONB value, so an in-place edit would never be written.
    policy.document = document;
    await policy.save();
    updated += 1;
  }
  return updated;
};

const backfillGuardrails = async (): Promise<number> => {
  const guardrails = await db.Guardrail.findAll({
    where: db.Guardrail.sequelize!.literal(varPrefilter('"document"')),
  });

  let updated = 0;
  for (const guardrail of guardrails) {
    const document = rewriteStoredGuardrailDocument(guardrail.document);
    if (!document) continue;
    guardrail.document = document;
    await guardrail.save();
    updated += 1;
  }
  return updated;
};

const backfillGuardrailVersions = async (): Promise<number> => {
  const versions = await db.GuardrailVersion.findAll({
    where: db.GuardrailVersion.sequelize!.literal(varPrefilter('"config"')),
  });

  let updated = 0;
  for (const version of versions) {
    const config = rewriteStoredGuardrailDocument(version.config);
    if (!config) continue;
    version.config = config;
    await version.save();
    updated += 1;
  }
  return updated;
};

const backfillFormations = async (): Promise<number> => {
  const formations = await db.Formation.findAll({
    where: db.Formation.sequelize!.literal(
      `"template" IS NOT NULL AND (${containsAny({
        column: '"template"',
        needles: [
          ...Object.keys(RENAMED_ACTIONS),
          ...Object.keys(RENAMED_VAR_PATHS),
        ],
      })})`
    ),
  });

  let updated = 0;
  for (const formation of formations) {
    const template = rewriteStoredFormationTemplate(formation.template);
    if (!template) continue;
    formation.template = template;
    await formation.save();
    updated += 1;
  }
  return updated;
};

export const backfillUsageRenames = async (): Promise<{
  policies: number;
  guardrails: number;
  guardrailVersions: number;
  formations: number;
}> => {
  const policies = await backfillPolicies();
  const guardrails = await backfillGuardrails();
  const guardrailVersions = await backfillGuardrailVersions();
  const formations = await backfillFormations();
  log(
    'backfillUsageRenames: policies=%d guardrails=%d guardrailVersions=%d formations=%d',
    policies,
    guardrails,
    guardrailVersions,
    formations
  );
  return { policies, guardrails, guardrailVersions, formations };
};
