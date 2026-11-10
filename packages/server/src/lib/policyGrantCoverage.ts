import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import {
  type Condition,
  matchesPattern,
  type PolicyDocument,
  type PolicySets,
  type Statement,
} from './iam';

const log = createDebug('soat:policyGrantCoverage');

type Walk = (i: number, j: number) => boolean;

/** Runs a two-cursor glob walk from the start, memoizing each position. */
const memoizedWalk = (step: (walk: Walk, i: number, j: number) => boolean) => {
  const memo = new Map<string, boolean>();
  const walk: Walk = (i, j) => {
    const key = `${i},${j}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    const result = step(walk, i, j);
    memo.set(key, result);
    return result;
  };
  return walk(0, 0);
};

/**
 * True when every value `inner` matches is matched by `outer` (`*` any run,
 * `?` one character). Sound, so a `true` is never wrong; an exotic pair of
 * globs may answer `false` for a true containment, which refuses.
 */
export const globCovers = (args: { outer: string; inner: string }): boolean => {
  const { outer, inner } = args;
  return memoizedWalk((walk, i, j) => {
    if (i === outer.length) return j === inner.length;
    if (outer[i] === '*') {
      return walk(i + 1, j) || (j < inner.length && walk(i, j + 1));
    }
    if (j === inner.length || inner[j] === '*') return false;
    return (outer[i] === '?' || inner[j] === outer[i]) && walk(i + 1, j + 1);
  });
};

/** A `*` on either side matches empty or swallows the other side's next token. */
const overlapStarStep = (args: {
  a: string;
  b: string;
  walk: Walk;
  i: number;
  j: number;
}): boolean | undefined => {
  const { a, b, walk, i, j } = args;
  if (a[i] === '*') return walk(i + 1, j) || (j < b.length && walk(i, j + 1));
  if (b[j] === '*') return walk(i, j + 1) || (i < a.length && walk(i + 1, j));
  return undefined;
};

/** True when some value matches both globs. */
export const globOverlaps = (args: { a: string; b: string }): boolean => {
  const { a, b } = args;
  return memoizedWalk((walk, i, j) => {
    const starred = overlapStarStep({ a, b, walk, i, j });
    if (starred !== undefined) return starred;
    if (i === a.length || j === b.length) {
      return i === a.length && j === b.length;
    }
    const same = a[i] === '?' || b[j] === '?' || a[i] === b[j];
    return same && walk(i + 1, j + 1);
  });
};

/**
 * A granted resource pattern as it reaches inside one project: an attached
 * policy acts only there, so `*` reads as that project's SRNs and a pattern
 * naming another project reaches nothing (`null`).
 */
const withinProject = (args: {
  pattern: string;
  projectPublicId: string;
}): string | null => {
  const { pattern, projectPublicId } = args;
  if (pattern === '*') return `srn:${projectPublicId}:*:*`;
  const parts = /^srn:([^:]+):(.+)$/.exec(pattern);
  if (!parts) return pattern;
  if (!matchesPattern({ pattern: parts[1], value: projectPublicId })) {
    return null;
  }
  return `srn:${projectPublicId}:${parts[2]}`;
};

const canonicalCondition = (condition: Condition | undefined): string => {
  if (!condition) return '';
  const operators = Object.keys(condition).sort() as (keyof Condition)[];
  return JSON.stringify(
    operators.map((operator) => {
      const block = condition[operator] ?? {};
      return [
        operator,
        Object.keys(block)
          .sort()
          .map((key) => {
            return [key, block[key]];
          }),
      ];
    })
  );
};

/**
 * A writer Allow covers a grant only unconditioned or under the very
 * condition the grant carries; any overlapping writer Deny, conditioned or
 * not, leaves the grant uncovered.
 */
const setCovers = (args: {
  docs: PolicyDocument[];
  grant: PolicyGrant;
}): boolean => {
  const statements = args.docs.flatMap((doc) => {
    return doc.statement;
  });
  const { action, resource, condition } = args.grant;
  const resourcesOf = (statement: Statement) => {
    return statement.resource ?? ['*'];
  };
  const denied = statements.some((statement) => {
    return (
      statement.effect === 'Deny' &&
      statement.action.some((pattern) => {
        return globOverlaps({ a: pattern, b: action });
      }) &&
      resourcesOf(statement).some((pattern) => {
        return globOverlaps({ a: pattern, b: resource });
      })
    );
  });
  if (denied) return false;
  return statements.some((statement) => {
    const statementCondition = canonicalCondition(statement.condition);
    return (
      statement.effect === 'Allow' &&
      (statementCondition === '' || statementCondition === condition) &&
      statement.action.some((pattern) => {
        return globCovers({ outer: pattern, inner: action });
      }) &&
      resourcesOf(statement).some((pattern) => {
        return globCovers({ outer: pattern, inner: resource });
      })
    );
  });
};

export type UngrantedGrant = {
  policy_id: string;
  statement: number;
  action: string;
  resource: string;
};

type PolicyGrant = UngrantedGrant & { condition: string };

/** Each action-resource pair one Allow statement grants inside the project. */
const statementGrants = (args: {
  policyId: string;
  index: number;
  statement: Statement;
  projectPublicId: string;
}): PolicyGrant[] => {
  const { policyId, index, statement, projectPublicId } = args;
  if (statement.effect !== 'Allow') return [];
  const condition = canonicalCondition(statement.condition);
  const resources = (statement.resource ?? ['*']).flatMap((pattern) => {
    const resource = withinProject({ pattern, projectPublicId });
    return resource === null ? [] : [resource];
  });
  return statement.action.flatMap((action) => {
    return resources.map((resource) => {
      return {
        policy_id: policyId,
        statement: index,
        action,
        resource,
        condition,
      };
    });
  });
};

const grantsOf = (args: {
  policies: { policyId: string; document: PolicyDocument }[];
  projectPublicId: string;
}): PolicyGrant[] => {
  return args.policies.flatMap(({ policyId, document }) => {
    return document.statement.flatMap((statement, index) => {
      return statementGrants({
        policyId,
        index,
        statement,
        projectPublicId: args.projectPublicId,
      });
    });
  });
};

/**
 * Every grant of `policies`, read inside `projectPublicId`, that some policy
 * set of the writer does not hold. A writer with no set holds nothing.
 */
export const findUncoveredGrants = (args: {
  writerSets: PolicySets;
  policies: { policyId: string; document: PolicyDocument }[];
  projectPublicId: string;
}): UngrantedGrant[] => {
  return grantsOf(args)
    .filter((grant) => {
      return (
        args.writerSets.length === 0 ||
        !args.writerSets.every((docs) => {
          return setCovers({ docs, grant });
        })
      );
    })
    .map(({ condition: _condition, ...ungranted }) => {
      return ungranted;
    });
};

export type GetWriterPolicies = (
  projectPublicId: string
) => Promise<PolicySets>;

const assertCovered = async (args: {
  getPolicies: GetWriterPolicies;
  policies: { policyId: string; document: PolicyDocument }[];
  projectPublicId: string;
}): Promise<void> => {
  const ungranted = findUncoveredGrants({
    writerSets: await args.getPolicies(args.projectPublicId),
    policies: args.policies,
    projectPublicId: args.projectPublicId,
  });
  if (ungranted.length === 0) return;
  log(
    'assertCovered: refused project=%s ungranted=%o',
    args.projectPublicId,
    ungranted
  );
  throw new DomainError(
    'POLICY_GRANT_NOT_HELD',
    'The policy grants permissions the caller does not hold.',
    { ungranted }
  );
};

/**
 * Attaching policies to a resource that acts under them (a trigger, an agent)
 * needs a writer who holds every grant they carry inside its project.
 */
export const assertWriterHoldsPolicies = async (args: {
  getPolicies: GetWriterPolicies;
  projectId: number;
  policyIds: number[];
}): Promise<void> => {
  log(
    'assertWriterHoldsPolicies: projectId=%d policyIds=%o',
    args.projectId,
    args.policyIds
  );
  if (args.policyIds.length === 0) return;
  const [project, rows] = await Promise.all([
    db.Project.findByPk(args.projectId, { rejectOnEmpty: true }),
    db.Policy.findAll({ where: { id: args.policyIds } }),
  ]);
  await assertCovered({
    getPolicies: args.getPolicies,
    projectPublicId: project.publicId as string,
    policies: rows.map((row) => {
      return {
        policyId: row.publicId as string,
        document: row.document as PolicyDocument,
      };
    }),
  });
};

/**
 * The projects of every trigger naming the policy, and of every agent whose
 * live config or any archived version names it: a version is served again by
 * a release or a restore.
 */
const projectsOfCarriers = async (
  policyPublicId: string
): Promise<string[]> => {
  const [rows] = await db.sequelize.query(
    `SELECT DISTINCT p.public_id
       FROM agents a
       JOIN projects p ON p.id = a.project_id
      WHERE a.policy_ids @> :ids::jsonb
         OR EXISTS (
              SELECT 1 FROM agent_versions v
               WHERE v.agent_id = a.id
                 AND (v.config::jsonb -> 'policy_ids') @> :ids::jsonb)
     UNION
     SELECT p.public_id
       FROM triggers t
       JOIN projects p ON p.id = t.project_id
      WHERE t.policy_ids @> :ids::jsonb`,
    { replacements: { ids: JSON.stringify([policyPublicId]) } }
  );
  return (rows as { public_id: string }[]).map((row) => {
    return row.public_id;
  });
};

/**
 * Editing a policy already attached to a resource that acts under it is
 * attaching the new document again, in every project it is attached in.
 */
export const assertWriterHoldsAttachedEdit = async (args: {
  getPolicies: GetWriterPolicies;
  policyPublicId: string;
  document: PolicyDocument;
}): Promise<void> => {
  log('assertWriterHoldsAttachedEdit: policy=%s', args.policyPublicId);
  const projectPublicIds = await projectsOfCarriers(args.policyPublicId);
  for (const projectPublicId of projectPublicIds) {
    await assertCovered({
      getPolicies: args.getPolicies,
      projectPublicId,
      policies: [{ policyId: args.policyPublicId, document: args.document }],
    });
  }
};
