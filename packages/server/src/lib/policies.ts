import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';

import { db } from '../db';
import { DomainError } from '../errors';
import { findPolicyCarriers } from './attachedPolicies';
import type { PolicyDocument } from './iam';
import { validatePolicyActions, validatePolicyDocument } from './iam';
import { emptyPage, paginatedList } from './pagination';
import {
  assertWriterHoldsAttachedEdit,
  type GetWriterPolicies,
} from './policyGrantCoverage';

const MAX_DEPENDENT_SAMPLE = 5;

const validatePolicy = (
  document: PolicyDocument
): { valid: boolean; errors: string[] } => {
  const structural = validatePolicyDocument(document);
  if (!structural.valid) return structural;
  return validatePolicyActions(document);
};

export const mapPolicy = (policy: InstanceType<(typeof db)['Policy']>) => {
  return {
    id: policy.publicId,
    name: policy.name,
    description: policy.description,
    document: policy.document as PolicyDocument | undefined,
    created_at: policy.createdAt,
    updated_at: policy.updatedAt,
  };
};

export const listPolicies = async (args?: {
  userId?: string;
  limit?: number;
  cursor?: string;
}) => {
  let where: Record<string, unknown> | undefined;

  // Optional user filter: return only the policies attached to that user.
  // An unknown user (or one with no policies) yields an empty list.
  if (args?.userId !== undefined) {
    const user = await db.User.findOne({ where: { publicId: args.userId } });
    const policyIds = (user?.policyIds as number[] | undefined) ?? [];
    if (policyIds.length === 0) return emptyPage(args ?? {});
    where = { id: policyIds };
  }

  return paginatedList({
    limit: args?.limit,
    cursor: args?.cursor,
    filters: { userId: args?.userId },
    where,
    order: [['createdAt', 'ASC']],
    query: ({ where: pageWhere, limit, order }) => {
      return db.Policy.findAll({ where: pageWhere, order, limit });
    },
    map: (p: InstanceType<(typeof db)['Policy']>) => {
      return mapPolicy(p);
    },
  });
};

export const createPolicy = async (args: {
  name?: string;
  description?: string;
  document: PolicyDocument;
}): Promise<
  ReturnType<typeof mapPolicy> | { invalid: true; errors: string[] }
> => {
  const validation = validatePolicy(args.document);
  if (!validation.valid) {
    return { invalid: true, errors: validation.errors };
  }

  const policy = await db.Policy.create({
    publicId: generatePublicId(PUBLIC_ID_PREFIXES.policy),
    name: args.name ?? null,
    description: args.description ?? null,
    document: args.document as object,
  });

  return mapPolicy(policy);
};

export const updatePolicy = async (args: {
  policyId: string;
  name?: string;
  description?: string;
  document: PolicyDocument;
  /** The writer's policy sets, which must hold the edit where it is attached. */
  writerPolicies: GetWriterPolicies;
}): Promise<
  ReturnType<typeof mapPolicy> | { invalid: true; errors: string[] }
> => {
  const validation = validatePolicy(args.document);
  if (!validation.valid) {
    return { invalid: true, errors: validation.errors };
  }
  await assertWriterHoldsAttachedEdit({
    getPolicies: args.writerPolicies,
    policyPublicId: args.policyId,
    document: args.document,
  });

  const policy = await db.Policy.findOne({
    where: { publicId: args.policyId },
  });
  if (!policy) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Policy '${args.policyId}' not found.`
    );
  }

  await policy.update({
    name: args.name ?? policy.name,
    description: args.description ?? policy.description,
    document: args.document as object,
  });

  return mapPolicy(policy);
};

export const deletePolicy = async (args: {
  policyId: string;
}): Promise<void> => {
  const policy = await db.Policy.findOne({
    where: { publicId: args.policyId },
  });
  if (!policy) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Policy '${args.policyId}' not found.`
    );
  }

  const { agents, triggers, webhooks } = await findPolicyCarriers({
    policyPublicId: args.policyId,
    limit: MAX_DEPENDENT_SAMPLE,
  });
  if (triggers.count > 0 || agents.count > 0 || webhooks.count > 0) {
    throw new DomainError(
      'POLICY_HAS_DEPENDENTS',
      `Policy '${args.policyId}' is attached to ${triggers.count} trigger(s), ${agents.count} agent(s) and ${webhooks.count} webhook(s); it cannot be deleted.`,
      {
        triggers: triggers.count,
        sample: triggers.sample,
        agents: agents.count,
        agent_sample: agents.sample,
        webhooks: webhooks.count,
        webhook_sample: webhooks.sample,
      }
    );
  }

  await policy.destroy();
};

export const getPolicy = async (args: { policyId: string }) => {
  const policy = await db.Policy.findOne({
    where: { publicId: args.policyId },
  });
  if (!policy) {
    return null;
  }

  return mapPolicy(policy);
};
