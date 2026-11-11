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
import {
  EVERY_PROJECT,
  POLICY_CARRIERS,
  type PolicyCarrier,
  type PolicyCarrierName,
} from './policyCarriers';

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
 * naming another project reaches nothing (`null`). In `EVERY_PROJECT` it
 * reaches as written.
 */
const withinProject = (args: {
  pattern: string;
  projectPublicId: string;
}): string | null => {
  const { pattern, projectPublicId } = args;
  if (projectPublicId === EVERY_PROJECT) return pattern;
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

type ScopedPolicy = {
  policyId: string;
  document: PolicyDocument;
  /** The project a project policy belongs to; `null` for a global one. */
  projectPublicId: string | null;
};

/** A project policy reaches only its own project, wherever it is attached. */
const scopeOf = (args: { actsIn: string; policy: ScopedPolicy }): string => {
  return args.actsIn === EVERY_PROJECT && args.policy.projectPublicId
    ? args.policy.projectPublicId
    : args.actsIn;
};

/**
 * Each scope's policies against the writer's sets for that scope; a writer
 * confined to one project holds nothing in `EVERY_PROJECT`.
 */
const assertCoveredIn = async (args: {
  getPolicies: GetWriterPolicies;
  actsIn: string[];
  policies: ScopedPolicy[];
}): Promise<void> => {
  const byScope = new Map<string, ScopedPolicy[]>();
  for (const actsIn of args.actsIn) {
    for (const policy of args.policies) {
      const scope = scopeOf({ actsIn, policy });
      byScope.set(scope, [...(byScope.get(scope) ?? []), policy]);
    }
  }
  for (const [projectPublicId, policies] of byScope) {
    await assertCovered({
      getPolicies: args.getPolicies,
      projectPublicId,
      policies,
    });
  }
};

const loadScopedPolicies = async (
  policyIds: number[]
): Promise<ScopedPolicy[]> => {
  const rows = await db.Policy.findAll({
    where: { id: policyIds },
    include: [{ model: db.Project, as: 'project', attributes: ['publicId'] }],
  });
  return rows.map((row) => {
    return {
      policyId: row.publicId as string,
      document: row.document as PolicyDocument,
      projectPublicId: row.project?.publicId ?? null,
    };
  });
};

/**
 * The one check every attach of policies to a carrier goes through, answered
 * by the carrier's `POLICY_CARRIERS` entry. `actsIn` is the carrier's project
 * public id, or `EVERY_PROJECT`.
 */
export const assertWriterMayAttach = async (args: {
  carrier: PolicyCarrierName;
  getPolicies: GetWriterPolicies;
  actsIn: string;
  policyIds: number[];
}): Promise<void> => {
  log(
    'assertWriterMayAttach: carrier=%s actsIn=%s policyIds=%o',
    args.carrier,
    args.actsIn,
    args.policyIds
  );
  const carrier: PolicyCarrier = POLICY_CARRIERS[args.carrier];
  if (carrier.attach === 'bounded_by_owner' || args.policyIds.length === 0) {
    return;
  }
  await assertCoveredIn({
    getPolicies: args.getPolicies,
    actsIn: [args.actsIn],
    policies: await loadScopedPolicies(args.policyIds),
  });
};

/**
 * The one check every policy edit goes through: editing a policy a carrier
 * names attaches the new document again, wherever each carrier acts.
 */
export const assertWriterHoldsAttachedEdit = async (args: {
  getPolicies: GetWriterPolicies;
  policy: { id: number; publicId: string; projectPublicId: string | null };
  document: PolicyDocument;
}): Promise<void> => {
  log('assertWriterHoldsAttachedEdit: policy=%s', args.policy.publicId);
  const carriers: PolicyCarrier[] = Object.values(POLICY_CARRIERS);
  const actsIn = await Promise.all(
    carriers.map((carrier) => {
      return carrier.actsIn(args.policy);
    })
  );
  await assertCoveredIn({
    getPolicies: args.getPolicies,
    actsIn: [...new Set(actsIn.flat())],
    policies: [
      {
        policyId: args.policy.publicId,
        document: args.document,
        projectPublicId: args.policy.projectPublicId,
      },
    ],
  });
};
