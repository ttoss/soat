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
 * Build WHERE fragments for condition keys that match `soat:ResourceTag/<key>`.
 * Uses `Op.contains` for parameterized JSONB equality, and Sequelize.fn for
 * LIKE/NOT-LIKE comparisons.
 */
const buildTagFragments = (
  condition: PolicyDocument['statement'][0]['condition'],
  fieldMap: ResourceFieldMap
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Array<Record<string, any>> => {
  if (!condition || !fieldMap.tagsColumn) return [];

  const col = colRef(fieldMap.tagsColumn);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const frags: Array<Record<string, any>> = [];

  for (const [op, block] of Object.entries(condition)) {
    if (!block) continue;
    for (const [key, expected] of Object.entries(
      block as Record<string, string>
    )) {
      if (!key.startsWith('soat:ResourceTag/')) continue;
      const tagKey = key.slice('soat:ResourceTag/'.length);

      if (op === 'StringEquals') {
        frags.push({ [col]: { [Op.contains]: { [tagKey]: expected } } });
      } else if (op === 'StringNotEquals') {
        frags.push({
          [Op.not]: { [col]: { [Op.contains]: { [tagKey]: expected } } },
        });
      } else if (op === 'StringLike') {
        // Use jsonb_extract_path_text + LIKE for glob pattern matching on tags.
        // Key is validated against a safe character set before use.
        if (!/^[\w.-]+$/.test(tagKey)) continue; // skip unsafe keys
        const colPath = fieldMap.tagsColumn.alias
          ? `${fieldMap.tagsColumn.alias}.${fieldMap.tagsColumn.column}`
          : fieldMap.tagsColumn.column;
        frags.push(
          Sequelize.where(
            Sequelize.fn(
              'jsonb_extract_path_text',
              Sequelize.col(colPath),
              tagKey
            ),
            { [Op.like]: globToLike(expected) }
          ) as unknown as Record<string, unknown>
        );
      }
    }
  }

  return frags;
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
  let hasAnyAllow = false;
  let unconditionalAllow = false;

  for (const policy of args.policies) {
    for (const statement of policy.statement) {
      const actionMatch = statement.action.some((a) => {
        return matchesPattern({ pattern: a, value: args.action });
      });
      if (!actionMatch) continue;

      const resources = statement.resource ?? ['*'];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resourceFrags: Array<Record<string, any>> = [];
      let stmtUnrestricted = false;

      for (const srnPattern of resources) {
        if (srnPattern === '*') {
          stmtUnrestricted = true;
          break;
        }
        const parts = srnPattern.split(':');
        if (parts.length < 4) {
          stmtUnrestricted = true;
          break;
        }
        // SRN: soat:<project>:<type>:<resource-segment>
        // Segments after index 3 are joined (path segments contain '/')
        const resourceSegment = parts.slice(3).join(':');
        if (resourceSegment === '*') {
          stmtUnrestricted = true;
          break;
        }
        const frag = buildResourceFragment(resourceSegment, fieldMap);
        if (frag === null) {
          stmtUnrestricted = true;
          break;
        }
        resourceFrags.push(frag);
      }

      const tagFrags = buildTagFragments(statement.condition, fieldMap);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const allFrags: Array<Record<string, any>> = [
        ...(stmtUnrestricted
          ? []
          : resourceFrags.length === 1
            ? resourceFrags
            : resourceFrags.length > 1
              ? [{ [Op.or]: resourceFrags }]
              : []),
        ...tagFrags,
      ];

      if (statement.effect === 'Deny') {
        if (stmtUnrestricted && tagFrags.length === 0) {
          // Unconditional deny-all — no query needed
          return { where: {}, hasAccess: false };
        }
        const denyWhere = allFrags.length === 0 ? {} : { [Op.and]: allFrags };
        denyFragments.push(denyWhere);
      } else {
        hasAnyAllow = true;
        if (stmtUnrestricted && tagFrags.length === 0) {
          unconditionalAllow = true;
        }
        const allowWhere = allFrags.length === 0 ? {} : { [Op.and]: allFrags };
        allowFragments.push(allowWhere);
      }
    }
  }

  if (!hasAnyAllow) {
    return { where: {}, hasAccess: false };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const whereParts: Array<Record<string, any>> = [];

  if (!unconditionalAllow && allowFragments.length > 0) {
    whereParts.push({ [Op.or]: allowFragments });
  }

  if (denyFragments.length > 0) {
    whereParts.push({ [Op.not]: { [Op.or]: denyFragments } });
  }

  const where = whereParts.length > 0 ? { [Op.and]: whereParts } : {};

  return { where, hasAccess: true };
};
