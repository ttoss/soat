import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import type { PolicyDocument } from './iam';
import type { PolicyCarrierName } from './policyCarriers';
import {
  assertWriterMayAttach,
  type GetWriterPolicies,
} from './policyGrantCoverage';
import { bindPolicyVariables } from './policyVariables';

const log = createDebug('soat:attachedPolicies');

/**
 * Whose grant a write attaching `policy_ids` to an agent or a trigger is
 * checked against. `archived` replays an agent version: its policies were held
 * when attached, and every edit to one since was checked where a version names
 * it.
 */
export type PolicyAttachUse = GetWriterPolicies | 'archived';

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
export const assertPoliciesAttachable = async (args: {
  carrier: PolicyCarrierName;
  policyIds?: string[] | null;
  current: string[] | null;
  projectId: number;
  policyUse: PolicyAttachUse;
}): Promise<void> => {
  if (!args.policyIds || args.policyIds.length === 0) return;
  log('assertPoliciesAttachable: policyIds=%o', args.policyIds);
  const rows = await loadPolicies(args.policyIds);
  const missing = args.policyIds.find((id) => {
    return !rows.some((row) => {
      return row.publicId === id;
    });
  });
  if (missing) {
    throw new DomainError('POLICY_NOT_FOUND', `Policy '${missing}' not found.`);
  }
  const foreign = rows.find((row) => {
    return row.projectId !== null && row.projectId !== args.projectId;
  });
  if (foreign) {
    throw new DomainError(
      'POLICY_OUTSIDE_PROJECT',
      `Policy '${foreign.publicId}' belongs to another project; name a policy of this project or a global one.`,
      { policy_id: foreign.publicId }
    );
  }
  if (args.policyUse === 'archived') return;
  const added = rows.filter((row) => {
    return !(args.current ?? []).includes(row.publicId);
  });
  if (added.length === 0) return;
  const project = await db.Project.findByPk(args.projectId, {
    rejectOnEmpty: true,
  });
  await assertWriterMayAttach({
    carrier: args.carrier,
    getPolicies: args.policyUse,
    actsIn: project.publicId as string,
    policyIds: added.map((row) => {
      return row.id as number;
    }),
  });
};

/**
 * Checks a write to a carrier whose `policy_ids` are required: a sent list
 * names at least one policy, else `refusal` says what the grant is for.
 */
export const assertRequiredPoliciesAttachable = async (args: {
  carrier: PolicyCarrierName;
  policyIds?: string[];
  current: string[] | null;
  projectId: number;
  policyUse: PolicyAttachUse;
  refusal: string;
}): Promise<void> => {
  if (args.policyIds === undefined) return;
  if (
    !Array.isArray(args.policyIds) ||
    args.policyIds.length === 0 ||
    !args.policyIds.every((id) => {
      return typeof id === 'string';
    })
  ) {
    throw new DomainError('VALIDATION_FAILED', args.refusal);
  }
  await assertPoliciesAttachable(args);
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

type Carriers = { count: number; sample: string[] };

const carriersOf = async (args: {
  rows: Promise<{ publicId: string }[]>;
  count: Promise<number>;
}): Promise<Carriers> => {
  const [rows, count] = await Promise.all([args.rows, args.count]);
  return {
    count,
    sample: rows.map((row) => {
      return row.publicId;
    }),
  };
};

/**
 * Live carriers naming the policy, for the refusal to delete it. An API key or
 * user naming a deleted policy only loses its grant, so neither refuses.
 */
export const findPolicyCarriers = async (args: {
  policyPublicId: string;
  limit: number;
}): Promise<{ agents: Carriers; triggers: Carriers; webhooks: Carriers }> => {
  const where = { policyIds: { [Op.contains]: [args.policyPublicId] } };
  const query = { where, attributes: ['publicId'], limit: args.limit };
  const [agents, triggers, webhooks] = await Promise.all([
    carriersOf({
      rows: db.Agent.findAll(query),
      count: db.Agent.count({ where }),
    }),
    carriersOf({
      rows: db.Trigger.findAll(query),
      count: db.Trigger.count({ where }),
    }),
    carriersOf({
      rows: db.Webhook.findAll(query),
      count: db.Webhook.count({ where }),
    }),
  ]);
  return { agents, triggers, webhooks };
};
