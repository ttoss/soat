import type { PolicyDocument } from './iam';
import { validatePolicyDocument } from './iam';
import { isPlainObject } from './plainObject';

/**
 * What an IAM token holds its issuing key to: stored policies by id, read as
 * they stand at each check, or an inline document. The key's grant ∩ the bound
 * is the most the token, and any work it starts, may do.
 */
export type PrincipalBound =
  { policyIds: string[] } | { policy: PolicyDocument };

/** The stored and signed form, as a JWT claim and a JSON column carry it. */
export const serializeBound = (bound: PrincipalBound): object => {
  return 'policyIds' in bound
    ? { policy_ids: bound.policyIds }
    : { policy: bound.policy };
};

/**
 * Reads a bound back from a claim or a column. `undefined` for an absent one;
 * `null` for a value that is not a bound, which the reader must refuse rather
 * than treat as no bound.
 */
export const parseBound = (
  value: unknown
): PrincipalBound | undefined | null => {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) return null;
  const policyIds = value.policy_ids;
  if (
    Array.isArray(policyIds) &&
    policyIds.length > 0 &&
    policyIds.every((id) => {
      return typeof id === 'string';
    })
  ) {
    return { policyIds };
  }
  const policy = value.policy;
  if (policy !== undefined && validatePolicyDocument(policy).valid) {
    return { policy: policy as PolicyDocument };
  }
  return null;
};
