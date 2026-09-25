import createDebug from 'debug';

import { db } from '../db';
import { isPlainObject } from './plainObject';

const log = createDebug('soat:usage');

/**
 * One-time rewrite of the stored policy documents that carry a usage action
 * under an older spelling.
 *
 * `isKnownAction` runs at authoring time only, so a stored document keeps
 * whatever string it was written with and a spelling the platform no longer
 * answers to silently changes what it does: an `Allow` grants nothing and a
 * `Deny` denies nothing (fail-open).
 *
 * Idempotent and prefiltered in SQL, so a converged database reads no rows and
 * it is safe to leave wired into every boot. The rewrite touches only names
 * the platform owns, enumerated below — never a string a tenant wrote.
 */

/** IAM action names the platform rewrites. Wildcards (`usage:*`) are untouched. */
const RENAMED_ACTIONS: Record<string, string> = {
  'usage:ListUsageMeters': 'usage:ListEvents',
  'usage:GetUsage': 'usage:GetAggregate',
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

type Rewritten = { value: unknown; changed: boolean };

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
 * Returns the rewritten formation template, or `null` when nothing in it
 * carried a renamed name.
 *
 * Enumerated by resource type rather than walked whole: a `policy` resource's
 * `document` is the only place an action string is the platform's. Every other
 * resource type is left alone.
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

const backfillFormations = async (): Promise<number> => {
  const formations = await db.Formation.findAll({
    where: db.Formation.sequelize!.literal(
      `"template" IS NOT NULL AND (${containsAny({
        column: '"template"',
        needles: Object.keys(RENAMED_ACTIONS),
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
  formations: number;
}> => {
  const policies = await backfillPolicies();
  const formations = await backfillFormations();
  log('backfillUsageRenames: policies=%d formations=%d', policies, formations);
  return { policies, formations };
};
