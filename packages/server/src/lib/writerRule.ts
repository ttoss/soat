import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import type { IsAllowedFn } from '../middleware/authProjectResolvers';
import { buildSrn } from './iam';
import { EVERY_PROJECT, type PolicyCarrierName } from './policyCarriers';
import {
  assertWriterMayAttach,
  type GetWriterPolicies,
} from './policyGrantCoverage';
import { assertSecretUseAllowed, SECRET_USE_ACTION } from './secretUse';
import { START_ACTIONS, type StartableType } from './startActions';

const log = createDebug('soat:writerRule');

/** Whoever creates or edits a carrier: the request's or the deployer's credential. */
export type Writer = { isAllowed: IsAllowedFn; getPolicies: GetWriterPolicies };

/** One action the carrier will perform on a resource of its project. */
export type CarriedAction = {
  action: string;
  resourceType: string;
  resourceId: string;
};

type WriterRuleCarrier = {
  /** Its `POLICY_CARRIERS` entry, when it carries `policy_ids`. */
  policies?: PolicyCarrierName;
  /** The refusal for an empty or absent list, when `policy_ids` is required. */
  policiesRequired?: string;
  /** Models whose rows hold what it acts on, for a carrier without policies. */
  models?: string[];
};

/**
 * Every resource that acts after the write that made it. Each write to one,
 * create or edit, goes through {@link assertWriterHolds} naming its entry
 * (`tests/harness/writerRule.test.mjs`).
 */
export const WRITER_RULE_CARRIERS = {
  agents: { policies: 'agents' },
  triggers: {
    policies: 'triggers',
    policiesRequired:
      'policy_ids must name at least one policy: the grant every firing acts under.',
  },
  webhooks: {
    policies: 'webhooks',
    policiesRequired:
      'policy_ids must name at least one policy: the grant that decides which events the webhook may read.',
  },
  apiKeys: { policies: 'apiKeys' },
  users: { policies: 'users' },
  orchestrations: { models: ['Orchestration'] },
  shares: { models: ['Share'] },
} satisfies Record<string, WriterRuleCarrier>;

export type WriterRuleCarrierName = keyof typeof WRITER_RULE_CARRIERS;

/**
 * Each action the rule asks of a writer beyond policies, with the resource
 * type it is asked on. A resource stored outside the runtime asks them of its
 * writer through `POST /api/v1/iam/check`.
 */
export const WRITER_RULE_ACTIONS: ReadonlyMap<string, string> = new Map([
  ...Object.values(START_ACTIONS).map((start): [string, string] => {
    return [start.action, start.resourceType];
  }),
  [SECRET_USE_ACTION, 'secret'],
]);

/** What starting the work of `type` named `id` performs. */
export const startOf = (args: {
  type: StartableType;
  id: string;
}): CarriedAction => {
  const start = START_ACTIONS[args.type];
  return {
    action: start.action,
    resourceType: start.resourceType,
    resourceId: start.byId ? args.id : '*',
  };
};

/**
 * The one reading of "these ids name policies": every id resolves, and a
 * carrier of `projectId` names only that project's policies or global ones.
 * `projectId` `null` is a carrier acting in every project.
 */
const resolvePolicies = async (args: {
  policyIds: string[];
  projectId: number | null;
}) => {
  const rows = await db.Policy.findAll({
    where: { publicId: args.policyIds },
  });
  const missing = args.policyIds.find((id) => {
    return !rows.some((row) => {
      return row.publicId === id;
    });
  });
  if (missing) {
    throw new DomainError('POLICY_NOT_FOUND', `Policy '${missing}' not found.`);
  }
  const foreign = rows.find((row) => {
    return (
      args.projectId !== null &&
      row.projectId !== null &&
      row.projectId !== args.projectId
    );
  });
  if (foreign) {
    throw new DomainError(
      'POLICY_OUTSIDE_PROJECT',
      `Policy '${foreign.publicId}' belongs to another project; name a policy of this project or a global one.`,
      { policy_id: foreign.publicId }
    );
  }
  return rows;
};

const readPolicyIds = (args: {
  carrier: WriterRuleCarrier;
  policyIds: string[] | null | undefined;
}): string[] => {
  const ids = args.policyIds ?? [];
  const valid =
    Array.isArray(ids) &&
    ids.every((id) => {
      return typeof id === 'string';
    });
  if (args.carrier.policiesRequired && (!valid || ids.length === 0)) {
    throw new DomainError('VALIDATION_FAILED', args.carrier.policiesRequired);
  }
  return ids;
};

const assertPoliciesHeld = async (args: {
  carrier: WriterRuleCarrier;
  writer: Writer;
  policyIds: string[] | null | undefined;
  projectId: number | null;
  actsIn: string;
}): Promise<{ id: number; publicId: string }[]> => {
  const policyIds = readPolicyIds(args);
  if (!args.carrier.policies || policyIds.length === 0) return [];
  const rows = await resolvePolicies({ policyIds, projectId: args.projectId });
  await assertWriterMayAttach({
    carrier: args.carrier.policies,
    getPolicies: args.writer.getPolicies,
    actsIn: args.actsIn,
    policyIds: rows.map((row) => {
      return row.id as number;
    }),
  });
  return rows.map((row) => {
    return { id: row.id as number, publicId: row.publicId as string };
  });
};

const assertActionsHeld = async (args: {
  writer: Writer;
  projectPublicId: string;
  actions: CarriedAction[];
}): Promise<void> => {
  for (const carried of args.actions) {
    const resource = buildSrn({
      projectPublicId: args.projectPublicId,
      resourceType: carried.resourceType,
      resourceId: carried.resourceId,
    });
    const allowed = await args.writer.isAllowed({
      projectPublicId: args.projectPublicId,
      action: carried.action,
      resource,
    });
    if (allowed) continue;
    log('assertActionsHeld: refused %s on %s', carried.action, resource);
    throw new DomainError(
      'ACTION_NOT_HELD',
      `The resource would perform ${carried.action} on ${resource}, which the caller may not.`,
      { action: carried.action, resource }
    );
  }
};

/**
 * The writer rule: whoever creates or edits a resource that acts later holds
 * the policies it carries, every action it will perform and every secret it
 * sends. `carried` is the resource as it stands after the write, so an edit
 * that changes none of them is still checked. Returns the resolved policies.
 */
export const assertWriterHolds = async (args: {
  carrier: WriterRuleCarrierName;
  writer: Writer;
  /** The carrier's project, or `null` for one acting in every project. */
  projectId: number | null;
  carried: {
    policyIds?: string[] | null;
    actions?: CarriedAction[];
    secretIds?: string[];
  };
}): Promise<{ id: number; publicId: string }[]> => {
  const carrier: WriterRuleCarrier = WRITER_RULE_CARRIERS[args.carrier];
  const project =
    args.projectId === null
      ? null
      : await db.Project.findByPk(args.projectId, {
          attributes: ['publicId'],
          rejectOnEmpty: true,
        });
  const rows = await assertPoliciesHeld({
    carrier,
    writer: args.writer,
    policyIds: args.carried.policyIds,
    projectId: args.projectId,
    actsIn: project?.publicId ?? EVERY_PROJECT,
  });
  if (project) {
    await assertActionsHeld({
      writer: args.writer,
      projectPublicId: project.publicId,
      actions: args.carried.actions ?? [],
    });
    await assertSecretUseAllowed({
      secretIds: args.carried.secretIds ?? [],
      projectId: args.projectId as number,
      isAllowed: args.writer.isAllowed,
    });
  }
  return rows;
};
