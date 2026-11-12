import type { AuthUser, Context } from '../Context';
import type { PolicySets } from '../lib/iam';
import { createPolicySetsIsAllowed } from '../lib/permissions';
import {
  createPinnedResolveProjectIds,
  createUnpinnedResolveProjectIds,
} from './authProjectResolvers';

export type Authority = Pick<
  AuthUser,
  'isAllowed' | 'getPolicies' | 'resolveProjectIds'
>;

/**
 * Where a credential reaches. `pinned` confines it to one project. An unpinned
 * credential lists every project unfiltered when `everyProject`, else the ones
 * its sets allow, probing first the projects `candidatePolicyIds` name, or every
 * project when `'all'`.
 */
export type Reach =
  | { pinned: string }
  | {
      pinned: null;
      everyProject: boolean;
      candidatePolicyIds: number[] | 'all';
    };

/**
 * A request's effective authority: every set must allow it, inside the pinned
 * project. Each credential kind and each narrowing states its reach and sets
 * here, so checks, list filters and project resolution share one answer.
 */
export const buildAuthority = (args: {
  reach: Reach;
  getSets: () => Promise<PolicySets>;
  db: Context['db'];
}): Authority => {
  const { reach, getSets, db } = args;
  const pinned = reach.pinned ?? undefined;
  const isAllowed = createPolicySetsIsAllowed({
    projectPublicId: pinned,
    getSets,
  });
  return {
    isAllowed,
    getPolicies: async (projectPublicId) => {
      return pinned && projectPublicId !== pinned ? [] : getSets();
    },
    resolveProjectIds:
      reach.pinned !== null
        ? createPinnedResolveProjectIds({
            pinnedProjectPublicId: reach.pinned,
            isAllowed,
            db,
          })
        : createUnpinnedResolveProjectIds({
            everyProject: reach.everyProject,
            candidatePolicyIds: reach.candidatePolicyIds,
            isAllowed,
            db,
          }),
  };
};

/**
 * `authority` pinned to `projectPublicId`, further bound by `bound`'s sets.
 * Never widens: the result holds every set the authority held.
 */
export const narrowAuthority = (args: {
  authority: Authority;
  projectPublicId: string;
  bound: () => Promise<PolicySets>;
  db: Context['db'];
}): Authority => {
  const { authority, projectPublicId } = args;
  let bound: Promise<PolicySets> | undefined;
  return buildAuthority({
    reach: { pinned: projectPublicId },
    getSets: async () => {
      const own = await authority.getPolicies(projectPublicId);
      bound ??= args.bound();
      return [...own, ...(await bound)];
    },
    db: args.db,
  });
};
