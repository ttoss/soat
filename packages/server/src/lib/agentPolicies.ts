import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import type { PolicyDocument } from './iam';
import {
  assertWriterHoldsPolicies,
  type GetWriterPolicies,
} from './policyGrantCoverage';
import { bindPolicyVariables } from './policyVariables';

const log = createDebug('soat:agentPolicies');

/**
 * Whose grant a write attaching `policy_ids` is checked against. `archived`
 * replays a version: its policies were held when attached, and every edit to
 * one since was checked where a version names it.
 */
export type AgentPolicyUse = GetWriterPolicies | 'archived';

/** Refuses every action: what a policy that no longer resolves allows. */
const DENY_ALL: PolicyDocument = {
  statement: [{ effect: 'Deny', action: ['*'], resource: ['*'] }],
};

const loadPolicies = async (publicIds: string[]) => {
  return db.Policy.findAll({ where: { publicId: publicIds } });
};

/**
 * Checks a write's `policy_ids`: every id names a policy, and the writer holds
 * every grant of the ones it adds to `current`.
 */
export const assertAgentPoliciesAttachable = async (args: {
  policyIds?: string[] | null;
  current: string[] | null;
  projectId: number;
  policyUse: AgentPolicyUse;
}): Promise<void> => {
  if (!args.policyIds || args.policyIds.length === 0) return;
  log('assertAgentPoliciesAttachable: policyIds=%o', args.policyIds);
  const rows = await loadPolicies(args.policyIds);
  const missing = args.policyIds.find((id) => {
    return !rows.some((row) => {
      return row.publicId === id;
    });
  });
  if (missing) {
    throw new DomainError('POLICY_NOT_FOUND', `Policy '${missing}' not found.`);
  }
  if (args.policyUse === 'archived') return;
  const added = rows.filter((row) => {
    return !(args.current ?? []).includes(row.publicId);
  });
  await assertWriterHoldsPolicies({
    getPolicies: args.policyUse,
    projectId: args.projectId,
    policyIds: added.map((row) => {
      return row.id as number;
    }),
  });
};

/**
 * The cap an agent's `policy_ids` put on one generation, with
 * `${soat:ActorId}` bound to the end user it runs for. `null` is no cap; a
 * policy that no longer resolves allows nothing.
 */
export const resolveAgentBoundary = async (args: {
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
    log('resolveAgentBoundary: unresolved in %o', args.policyIds);
    return DENY_ALL;
  }
  const merged: PolicyDocument = {
    statement: rows.flatMap((row) => {
      return (row.document as PolicyDocument).statement ?? [];
    }),
  };
  return bindPolicyVariables({ document: merged, actorId: args.actorId });
};

/** Live agents naming the policy, for the refusal to delete it. */
export const findAgentsCarryingPolicy = async (args: {
  policyPublicId: string;
  limit: number;
}): Promise<{ count: number; sample: string[] }> => {
  const where = { policyIds: { [Op.contains]: [args.policyPublicId] } };
  const [rows, count] = await Promise.all([
    db.Agent.findAll({ where, attributes: ['publicId'], limit: args.limit }),
    db.Agent.count({ where }),
  ]);
  return {
    count,
    sample: rows.map((row) => {
      return row.publicId;
    }),
  };
};
