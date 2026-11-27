import type { Context } from '../Context';
import {
  resolveAttachedPolicies,
  resolveAttachedPolicySet,
  resolveBoundSets,
} from '../lib/attachedPolicies';
import type { DeniedPrincipal } from '../lib/authorizationDenial';
import type { PolicyDocument } from '../lib/iam';
import { buildConsentPolicyFromScopeClaim } from '../lib/oauthConsent';
import type { PrincipalBound } from '../lib/principalBound';
import {
  loadOwnedProjectGroupsGrant,
  loadProjectGroupConfinement,
} from '../lib/projectGroupAuthority';
import {
  type Bound,
  type Cap,
  docsBound,
  EVERYTHING,
  type Grant,
  NOTHING,
} from './authority';

/** A policy that no longer resolves allows nothing, as on every carrier. */
const policiesBound = (args: { policyIds: string[] }): Bound => {
  return {
    allows: 'policies',
    load: async () => {
      const grant = await resolveAttachedPolicies({
        policyIds: args.policyIds,
        actorId: null,
      });
      return [grant ? [grant] : []];
    },
  };
};

/**
 * What a user holds: everything for an `admin`, else its policies and the
 * own resources of every project group it owns. A user holding neither holds nothing.
 */
export const userBound = (args: {
  role: 'admin' | 'user';
  userPublicId: string;
  policyIds: string[];
}): Bound => {
  if (args.role === 'admin') return EVERYTHING;
  // Read once per request: owning a project group is not revoked mid-request.
  let ownedProjectGroups: Promise<PolicyDocument | null> | undefined;
  return {
    allows: 'policies',
    load: async () => {
      ownedProjectGroups ??= loadOwnedProjectGroupsGrant({
        userPublicId: args.userPublicId,
      });
      const [own, owned] = await Promise.all([
        args.policyIds.length === 0
          ? null
          : resolveAttachedPolicies({
              policyIds: args.policyIds,
              actorId: null,
            }),
        ownedProjectGroups,
      ]);
      return [
        [own, owned].filter((doc): doc is PolicyDocument => {
          return doc !== null;
        }),
      ];
    },
  };
};

export const userGrant = (args: {
  principal: DeniedPrincipal;
  role: 'admin' | 'user';
  userPublicId: string;
  policyIds: string[];
}): Grant => {
  return { principal: args.principal, holder: 'user', bound: userBound(args) };
};

/**
 * A key's own `policy_ids`: a key stored with none is not narrowed. A key no
 * longer stored narrows to nothing. A project group key acts only in its project group.
 */
export const keyBound = (args: {
  policyIds: string[] | null;
  projectGroupId?: number | null;
}): Bound => {
  if (args.policyIds === null) return NOTHING;
  const { projectGroupId } = args;
  const own =
    args.policyIds.length === 0
      ? EVERYTHING
      : policiesBound({ policyIds: args.policyIds });
  if (projectGroupId === undefined || projectGroupId === null) return own;
  return {
    allows: 'policies',
    load: async () => {
      const confinement = [
        await loadProjectGroupConfinement({ projectGroupId }),
      ];
      if (own.allows === 'everything') return [confinement];
      return [
        ...(own.allows === 'policies' ? await own.load() : [[]]),
        confinement,
      ];
    },
  };
};

/** An OAuth token's consented scope, rebuilt from its `scope` claim. */
export const oauthScopeCap = (args: {
  principal: DeniedPrincipal;
  projectPublicId: string;
  scopeClaim: string | undefined;
}): Cap => {
  return {
    principal: args.principal,
    kind: 'other',
    bound: docsBound([
      buildConsentPolicyFromScopeClaim({
        projectPublicId: args.projectPublicId,
        scopeClaim: args.scopeClaim,
      }),
    ]),
  };
};

/** An IAM token bound, carried by the token or by work one started. */
export const principalBoundCap = (args: {
  principal: DeniedPrincipal;
  bound: PrincipalBound;
}): Cap => {
  return {
    principal: args.principal,
    kind: 'other',
    bound: {
      allows: 'policies',
      load: () => {
        return resolveBoundSets(args.bound);
      },
    },
  };
};

/**
 * A resource's own `policy_ids`, read live when checked: its firings' or its
 * work's grant. A resource no longer stored, or one with no policy, grants
 * nothing.
 */
export const ownPoliciesGrant = (args: {
  principal: DeniedPrincipal;
  policyIds: () => Promise<string[] | null>;
}): Grant => {
  return {
    principal: args.principal,
    holder: 'resource',
    bound: {
      allows: 'policies',
      load: async () => {
        return [
          await resolveAttachedPolicySet({ policyIds: await args.policyIds() }),
        ];
      },
    },
  };
};

/** A trigger's `policy_ids`, the grant its firings act under. */
export const triggerGrant = (args: {
  principal: DeniedPrincipal;
  triggerPublicId: string;
  db: Context['db'];
}): Grant => {
  return ownPoliciesGrant({
    principal: args.principal,
    policyIds: async () => {
      const trigger = await args.db.Trigger.findOne({
        where: { publicId: args.triggerPublicId },
      });
      return trigger?.policyIds ?? null;
    },
  });
};

/**
 * A `run_as: agent` turn's grant: the agent's resolved `policy_ids`. None
 * resolving grants nothing.
 */
export const agentGrant = (args: {
  agentId: string;
  policy: PolicyDocument | null;
}): Grant => {
  return {
    principal: { type: 'agent', id: args.agentId },
    holder: 'resource',
    bound: docsBound(args.policy ? [args.policy] : []),
  };
};
