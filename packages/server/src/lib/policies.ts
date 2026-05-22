import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';

import { db } from '../db';
import { DomainError } from '../errors';
import type { PolicyDocument } from './iam';
import { validatePolicyDocument } from './iam';

export const mapPolicy = (policy: InstanceType<(typeof db)['Policy']>) => {
  return {
    id: policy.publicId,
    name: policy.name,
    description: policy.description,
    document: policy.document as PolicyDocument | undefined,
    createdAt: policy.createdAt,
    updatedAt: policy.updatedAt,
  };
};

export const listPolicies = async () => {
  const policies = await db.Policy.findAll();
  return policies.map((p: InstanceType<(typeof db)['Policy']>) => {
    return mapPolicy(p);
  });
};

export const createPolicy = async (args: {
  name?: string;
  description?: string;
  document: PolicyDocument;
}): Promise<
  ReturnType<typeof mapPolicy> | { invalid: true; errors: string[] }
> => {
  const validation = validatePolicyDocument(args.document);
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
}): Promise<ReturnType<typeof mapPolicy> | { invalid: true; errors: string[] }> => {
  const validation = validatePolicyDocument(args.document);
  if (!validation.valid) {
    return { invalid: true, errors: validation.errors };
  }

  const policy = await db.Policy.findOne({
    where: { publicId: args.policyId },
  });
  if (!policy) {
    throw new DomainError('RESOURCE_NOT_FOUND', `Policy '${args.policyId}' not found.`);
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
    throw new DomainError('RESOURCE_NOT_FOUND', `Policy '${args.policyId}' not found.`);
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
