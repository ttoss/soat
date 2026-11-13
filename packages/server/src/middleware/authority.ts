import type { AuthUser, Context } from '../Context';
import type { DeniedPrincipal } from '../lib/authorizationDenial';
import {
  createPolicySetsIsAllowed,
  type LabeledPolicySets,
  unlabelPolicySets,
} from '../lib/permissions';
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
 * here, each set labeled with its principal so a refusal names the one that
 * refused, and checks, list filters and project resolution share one answer.
 */
export const buildAuthority = (args: {
  reach: Reach;
  getSets: () => Promise<LabeledPolicySets>;
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
      return pinned && projectPublicId !== pinned
        ? []
        : unlabelPolicySets(await getSets());
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
 * Never widens: the result holds every set the authority held, labeled
 * `principal`, ahead of the bound's.
 */
export const narrowAuthority = (args: {
  authority: Authority;
  principal: DeniedPrincipal;
  projectPublicId: string;
  bound: () => Promise<LabeledPolicySets>;
  db: Context['db'];
}): Authority => {
  const { authority, principal, projectPublicId } = args;
  let bound: Promise<LabeledPolicySets> | undefined;
  return buildAuthority({
    reach: { pinned: projectPublicId },
    getSets: async () => {
      const own = await authority.getPolicies(projectPublicId);
      bound ??= args.bound();
      return [{ principal, sets: own }, ...(await bound)];
    },
    db: args.db,
  });
};
