import type { AuthUser, Context } from '../Context';
import type { DeniedPrincipal } from '../lib/authorizationDenial';
import type { PolicyDocument, PolicySets } from '../lib/iam';
import {
  createPolicySetsIsAllowed,
  type LabeledPolicySets,
  unlabelPolicySets,
} from '../lib/permissions';
import { buildRequestTagContext } from '../lib/tags';
import { resolveReachableProjectIds } from './authProjectResolvers';

/**
 * What one grant or cap allows, always stated: `policies` loads per check, so
 * a revoked policy takes effect on the next one, and a load that yields no set
 * allows nothing.
 */
export type Bound =
  | { allows: 'everything' }
  | { allows: 'nothing' }
  | { allows: 'policies'; load: () => Promise<PolicySets> };

export const EVERYTHING: Bound = { allows: 'everything' };
export const NOTHING: Bound = { allows: 'nothing' };

/** A bound over one policy-document list: an empty list allows nothing. */
export const docsBound = (docs: PolicyDocument[]): Bound => {
  return docs.length === 0
    ? NOTHING
    : {
        allows: 'policies',
        load: async () => {
          return [docs];
        },
      };
};

/**
 * Who holds the request's grant: a `user` (the credential's owner), or a
 * `resource` acting under its own `policy_ids` (a trigger).
 */
export type Grant = {
  principal: DeniedPrincipal;
  holder: 'user' | 'resource';
  bound: Bound;
};

/**
 * What narrows the grant: the presenting key's own `policy_ids`
 * (`key_policies`), or anything else (`other`: an OAuth scope, an IAM
 * token, an On-Behalf-Of assertion, a token's acting key).
 */
export type Cap = {
  principal: DeniedPrincipal;
  kind: 'key_policies' | 'other';
  bound: Bound;
};

/** A credential's authority, as each kind states it: grant ∩ caps, pinned. */
export type AuthorityTerms = {
  pinned: string | null;
  grant: Grant;
  caps: Cap[];
};

export type Authority = Pick<
  AuthUser,
  | 'isAllowed'
  | 'getPolicies'
  | 'getLabeledPolicies'
  | 'resolveProjectIds'
  | 'unrestricted'
  | 'operator'
  | 'narrowing'
  | 'declareRequestTags'
>;

const ADMIN_WILDCARD_POLICY: PolicyDocument = {
  statement: [{ effect: 'Allow', action: ['*'], resource: ['*'] }],
};

const NOTHING_SETS: PolicySets = [[]];

export const boundSets = async (bound: Bound): Promise<PolicySets> => {
  if (bound.allows === 'everything') return [[ADMIN_WILDCARD_POLICY]];
  if (bound.allows === 'nothing') return NOTHING_SETS;
  const sets = await bound.load();
  return sets.length === 0 ? NOTHING_SETS : sets;
};

/**
 * The sets every check and list filter reads: the grant's, then each cap that
 * narrows. Never empty: the grant always contributes a set.
 */
const termsSets = async (terms: AuthorityTerms): Promise<LabeledPolicySets> => {
  const caps = terms.caps.filter((cap) => {
    return cap.bound.allows !== 'everything';
  });
  return Promise.all(
    [terms.grant, ...caps].map(async ({ principal, bound }) => {
      return { principal, sets: await boundSets(bound) };
    })
  );
};

const uncapped = (terms: AuthorityTerms): boolean => {
  return terms.caps.every((cap) => {
    return cap.bound.allows === 'everything';
  });
};

/**
 * What narrows the grant: nothing, only the presenting key's own `policy_ids`,
 * or anything beyond them. A resource's grant in place of the user's, and a
 * cap of kind `other` whatever it allows (a token naming no key is still a
 * token), are beyond them.
 */
const narrowingOf = (terms: AuthorityTerms): AuthUser['narrowing'] => {
  if (
    terms.grant.holder !== 'user' ||
    terms.caps.some((cap) => {
      return cap.kind === 'other';
    })
  ) {
    return 'beyond_key';
  }
  return uncapped(terms) ? 'none' : 'key_policies';
};

/**
 * A request's effective authority: its grant ∩ every cap, inside the pinned
 * project. Each credential kind and each narrowing states its terms here, and
 * checks, list filters, project resolution and key creation read one answer.
 */
export const buildAuthority = (args: {
  terms: AuthorityTerms;
  db: Context['db'];
}): Authority => {
  const { terms, db } = args;
  const operator = terms.grant.bound.allows === 'everything';
  const unrestricted = operator && terms.pinned === null && uncapped(terms);
  const getSets = () => {
    return termsSets(terms);
  };
  const checkPolicies = createPolicySetsIsAllowed({
    projectPublicId: terms.pinned ?? undefined,
    getSets,
  });
  // The tags this request writes, as `iam:RequestTag/<key>`: one request per
  // authority, so every check it makes reads them, the project probe of a
  // create included.
  const requestTagContext: Record<string, string> = {};
  const isAllowed = Object.assign(
    (check: Parameters<typeof checkPolicies>[0]) => {
      return checkPolicies({
        ...check,
        context: { ...requestTagContext, ...check.context },
      });
    },
    { refusedBy: checkPolicies.refusedBy }
  );
  const getLabeledPolicies = async (
    projectPublicId: string
  ): Promise<LabeledPolicySets> => {
    if (terms.pinned !== null && projectPublicId !== terms.pinned) {
      return [{ principal: terms.grant.principal, sets: NOTHING_SETS }];
    }
    return getSets();
  };
  return {
    isAllowed,
    getLabeledPolicies,
    getPolicies: async (projectPublicId) => {
      return unlabelPolicySets(await getLabeledPolicies(projectPublicId));
    },
    resolveProjectIds: (req) => {
      return resolveReachableProjectIds({
        ...req,
        pinned: terms.pinned,
        unrestricted,
        grantSets: async () => {
          return boundSets(terms.grant.bound);
        },
        isAllowed,
        db,
      });
    },
    unrestricted,
    operator,
    narrowing: narrowingOf(terms),
    declareRequestTags: (tags) => {
      Object.assign(requestTagContext, buildRequestTagContext(tags));
    },
  };
};
