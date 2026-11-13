import createDebug from 'debug';

import { db } from '../db';
import type { PolicyDocument, PolicySets } from './iam';
import { bindPolicyVariables } from './policyVariables';
import type { PrincipalBound } from './principalBound';

const log = createDebug('soat:attachedPolicies');

/** Refuses every action: what a policy that no longer resolves allows. */
const DENY_ALL: PolicyDocument = {
  statement: [{ effect: 'Deny', action: ['*'], resource: ['*'] }],
};

const loadPolicies = async (publicIds: string[]) => {
  return db.Policy.findAll({ where: { publicId: publicIds } });
};

/**
 * The grant `policy_ids` carry as one document, with `${iam:ActorId}` bound
 * to the end user it acts for. `null` is no cap; a policy that no longer
 * resolves allows nothing.
 */
export const resolveAttachedPolicies = async (args: {
  policyIds: unknown;
  actorId: string | null | undefined;
}): Promise<PolicyDocument | null> => {
  if (!Array.isArray(args.policyIds) || args.policyIds.length === 0) {
    return null;
  }
  const publicIds = args.policyIds.filter((id): id is string => {
    return typeof id === 'string';
  });
  const rows = await loadPolicies(publicIds);
  if (rows.length !== new Set(args.policyIds).size) {
    log('resolveAttachedPolicies: unresolved in %o', args.policyIds);
    return DENY_ALL;
  }
  const merged: PolicyDocument = {
    statement: rows.flatMap((row) => {
      return (row.document as PolicyDocument).statement ?? [];
    }),
  };
  return bindPolicyVariables({ document: merged, actorId: args.actorId });
};

/**
 * The policy set `policyIds` act under when nobody called: the grant alone. An
 * empty list is a set with no document, which allows nothing.
 */
export const resolveAttachedPolicySet = async (args: {
  policyIds: unknown;
}): Promise<PolicyDocument[]> => {
  const grant = await resolveAttachedPolicies({
    policyIds: args.policyIds,
    actorId: null,
  });
  return grant ? [grant] : [];
};

/** The policy sets a bound adds, each of which every request must satisfy. */
export const resolveBoundSets = async (
  bound: PrincipalBound
): Promise<PolicySets> => {
  if ('all' in bound) {
    return (await Promise.all(bound.all.map(resolveBoundSets))).flat();
  }
  if ('policySets' in bound) return bound.policySets;
  if ('policy' in bound) return [[bound.policy]];
  return [await resolveAttachedPolicySet({ policyIds: bound.policyIds })];
};
