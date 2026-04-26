import { Op, Sequelize } from '@ttoss/postgresdb';

import type { PolicyDocument } from './iam';
import { matchesPattern } from './iam';

// ── Types ────────────────────────────────────────────────────────────────

/**
 * Describes how a resource's fields map to Sequelize column references.
 * - `column`: the database column name (e.g. 'publicId', 'path', 'tags')
 * - `alias`: if the column is on an associated (joined) model, the association
 *   alias used in the query (e.g. 'file'). When set, the column reference is
 *   rendered as `$alias.column$` which requires `subQuery: false` in the query.
 */
export type ColumnSpec = {
  column: string;
  alias?: string;
};

/**
 * Registry entry that maps resource field roles to Sequelize column specs.
 * Register one entry per resource type via `registerResourceFieldMap`.
 */
export type ResourceFieldMap = {
  resourceType: string;
  publicIdColumn: ColumnSpec;
  pathColumn?: ColumnSpec;
  tagsColumn?: ColumnSpec;
};

export type CompiledPolicy = {
  /**
   * Sequelize WhereOptions to apply to the query. When `hasAccess` is false
   * this is `{}` and the caller must return an empty result set.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  where: Record<string, any>;
  /**
   * True when at least one Allow statement matched the action and no
   * unconditional Deny blocks all access.
   */
  hasAccess: boolean;
};

// ── Registry ─────────────────────────────────────────────────────────────

const registeredMaps = new Map<string, ResourceFieldMap>();

export const registerResourceFieldMap = (map: ResourceFieldMap): void => {
  registeredMaps.set(map.resourceType, map);
};

// ── Helpers ───────────────────────────────────────────────────────────────

const colRef = (spec: ColumnSpec): string => {
  return spec.alias ? `$${spec.alias}.${spec.column}$` : spec.column;
};

export const globToLike = (pattern: string): string => {
  return pattern
    .replace(/%/g, '\\%') // escape literal %
    .replace(/_/g, '\\_') // escape literal _
    .replace(/\*/g, '%') // glob * → SQL LIKE %
    .replace(/\?/g, '_'); // glob ? → SQL LIKE _
};

const isGlob = (s: string): boolean => {
  return /[*?]/.test(s);
};

/**
 * Build a WHERE fragment for a single SRN resource segment.
 * Returns null when the segment is '*' (unrestricted — no WHERE needed).
 */

const buildResourceFragment = (
  resourceSegment: string,
  fieldMap: ResourceFieldMap
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> | null => {
  if (resourceSegment === '*') return null;

  if (resourceSegment.startsWith('/') && fieldMap.pathColumn) {
    const col = colRef(fieldMap.pathColumn);
    return isGlob(resourceSegment)
      ? { [col]: { [Op.like]: globToLike(resourceSegment) } }
      : { [col]: resourceSegment };
  }

  const col = colRef(fieldMap.publicIdColumn);
  return isGlob(resourceSegment)
    ? { [col]: { [Op.like]: globToLike(resourceSegment) } }
    : { [col]: resourceSegment };
};

/**
 * Build a WHERE fragment for a single tag key-value pair with StringEquals.
 */
const buildTagEqualsFragment = (
  col: string,
  tagKey: string,
  expected: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> => {
  return { [col]: { [Op.contains]: { [tagKey]: expected } } };
};

/**
 * Build a WHERE fragment for a single tag key-value pair with StringNotEquals.
 */
const buildTagNotEqualsFragment = (
  col: string,
  tagKey: string,
  expected: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> => {
  return {
    [Op.not]: { [col]: { [Op.contains]: { [tagKey]: expected } } },
  };
};

/**
 * Build a WHERE fragment for a single tag key-value pair with StringLike.
 */
const buildTagLikeFragment = (
  fieldMap: ResourceFieldMap,
  tagKey: string,
  expected: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> | null => {
  if (!/^[\w.-]+$/.test(tagKey)) return null; // skip unsafe keys
  const tagsColumn = fieldMap.tagsColumn!;
  const colPath = tagsColumn.alias
    ? `${tagsColumn.alias}.${tagsColumn.column}`
    : tagsColumn.column;
  return Sequelize.where(
    Sequelize.fn('jsonb_extract_path_text', Sequelize.col(colPath), tagKey),
    { [Op.like]: globToLike(expected) }
  ) as unknown as Record<string, unknown>;
};

/**
 * Build WHERE fragments for condition keys that match `soat:ResourceTag/<key>`.
 * Uses `Op.contains` for parameterized JSONB equality, and Sequelize.fn for
 * LIKE/NOT-LIKE comparisons.
 */
const buildTagFragmentForKey = (args: {
  op: string;
  col: string;
  tagKey: string;
  expected: string;
  fieldMap: ResourceFieldMap;
}): Array<Record<string, unknown>> => {
  if (args.op === 'StringEquals') {
    return [buildTagEqualsFragment(args.col, args.tagKey, args.expected)];
  }
  if (args.op === 'StringNotEquals') {
    return [buildTagNotEqualsFragment(args.col, args.tagKey, args.expected)];
  }
  if (args.op === 'StringLike') {
    const frag = buildTagLikeFragment(
      args.fieldMap,
      args.tagKey,
      args.expected
    );
    return frag ? [frag] : [];
  }
  return [];
};

const buildTagFragments = (
  condition: PolicyDocument['statement'][0]['condition'],
  fieldMap: ResourceFieldMap
): Array<Record<string, unknown>> => {
  if (!condition || !fieldMap.tagsColumn) return [];

  const col = colRef(fieldMap.tagsColumn);

  const frags: Array<Record<string, unknown>> = [];

  for (const [op, block] of Object.entries(condition)) {
    if (!block) continue;
    for (const [key, expected] of Object.entries(
      block as Record<string, string>
    )) {
      if (!key.startsWith('soat:ResourceTag/')) continue;
      const tagKey = key.slice('soat:ResourceTag/'.length);

      const tagFrags = buildTagFragmentForKey({
        op,
        col,
        tagKey,
        expected,
        fieldMap,
      });
      frags.push(...tagFrags);
    }
  }

  return frags;
};

/**
 * Process resources for a statement and determine if it's unrestricted.
 * Returns the list of resource fragments and unrestricted flag.
 */
const processStatementResources = (
  resources: string[],
  fieldMap: ResourceFieldMap
): { frags: Array<Record<string, unknown>>; unrestricted: boolean } => {
  const frags: Array<Record<string, unknown>> = [];

  for (const srnPattern of resources) {
    if (srnPattern === '*') return { frags, unrestricted: true };

    const parts = srnPattern.split(':');
    if (parts.length < 4) return { frags, unrestricted: true };

    const resourceSegment = parts.slice(3).join(':');
    if (resourceSegment === '*') return { frags, unrestricted: true };

    const frag = buildResourceFragment(resourceSegment, fieldMap);
    if (frag === null) return { frags, unrestricted: true };

    frags.push(frag);
  }

  return { frags, unrestricted: false };
};

/**
 * Build combined fragments from resources and tags.
 */

const buildStatementFragments = (args: {
  resourceFrags: Array<Record<string, unknown>>;
  tagFrags: Array<Record<string, unknown>>;
  unrestricted: boolean;
}): Array<Record<string, unknown>> => {
  return [
    ...(args.unrestricted
      ? []
      : args.resourceFrags.length === 1
        ? args.resourceFrags
        : args.resourceFrags.length > 1
          ? [{ [Op.or]: args.resourceFrags }]
          : []),
    ...args.tagFrags,
  ];
};

/**
 * Process a single statement and update allow/deny fragments.
 */
const processStatement = (args: {
  statement: PolicyDocument['statement'][0];
  action: string;
  fieldMap: ResourceFieldMap;
  allowFragments: Array<Record<string, unknown>>;
  denyFragments: Array<Record<string, unknown>>;
  context: { hasAnyAllow: boolean; unconditionalAllow: boolean };
}): boolean => {
  const actionMatch = args.statement.action.some((a) => {
    return matchesPattern({ pattern: a, value: args.action });
  });
  if (!actionMatch) return false;

  const resources = args.statement.resource ?? ['*'];
  const { frags: resourceFrags, unrestricted } = processStatementResources(
    resources,
    args.fieldMap
  );

  const tagFrags = buildTagFragments(args.statement.condition, args.fieldMap);
  const allFrags = buildStatementFragments({
    resourceFrags,
    tagFrags,
    unrestricted,
  });

  if (args.statement.effect === 'Deny') {
    if (unrestricted && tagFrags.length === 0) return true; // deny-all
    const denyWhere = allFrags.length === 0 ? {} : { [Op.and]: allFrags };
    args.denyFragments.push(denyWhere);
  } else {
    args.context.hasAnyAllow = true;
    if (unrestricted && tagFrags.length === 0) {
      args.context.unconditionalAllow = true;
    }
    const allowWhere = allFrags.length === 0 ? {} : { [Op.and]: allFrags };
    args.allowFragments.push(allowWhere);
  }

  return false;
};

// ── Core compiler ─────────────────────────────────────────────────────────

/**
 * Compile a set of policy documents into a Sequelize WHERE clause that
 * enforces resource-level access control for list-style queries.
 *
 * - Each Allow statement contributes an OR-branch that users must satisfy.
 * - Deny statements contribute AND-NOT conditions that always apply.
 * - An unconditional Deny-all (resource='*', no conditions) returns
 *   `{ hasAccess: false }` immediately.
 * - If no Allow statement matches the action the caller has no access.
 *
 * The returned `where` must be merged into the top-level Sequelize query.
 * When the fieldMap contains columns with an `alias` (e.g. `$file.path$`),
 * set `subQuery: false` on the query to enable association column references.
 */
export const compilePolicy = (args: {
  policies: PolicyDocument[];
  action: string;
  resourceType: string;
  projectPublicId: string;
}): CompiledPolicy => {
  const fieldMap = registeredMaps.get(args.resourceType);
  if (!fieldMap) {
    throw new Error(
      `No ResourceFieldMap registered for resourceType '${args.resourceType}'`
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allowFragments: Array<Record<string, any>> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const denyFragments: Array<Record<string, any>> = [];
  const context = { hasAnyAllow: false, unconditionalAllow: false };

  for (const policy of args.policies) {
    for (const statement of policy.statement) {
      const isDenyAll = processStatement({
        statement,
        action: args.action,
        fieldMap,
        allowFragments,
        denyFragments,
        context,
      });
      if (isDenyAll) return { where: {}, hasAccess: false };
    }
  }

  if (!context.hasAnyAllow) return { where: {}, hasAccess: false };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const whereParts: Array<Record<string, any>> = [];

  if (!context.unconditionalAllow && allowFragments.length > 0) {
    whereParts.push({ [Op.or]: allowFragments });
  }

  if (denyFragments.length > 0) {
    whereParts.push({ [Op.not]: { [Op.or]: denyFragments } });
  }

  const where = whereParts.length > 0 ? { [Op.and]: whereParts } : {};

  return { where, hasAccess: true };
};
