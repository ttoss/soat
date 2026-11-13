import type { PolicyDocument, PolicySets } from './iam';
import { validatePolicyDocument } from './iam';
import { isPlainObject } from './plainObject';

type BoundTerm =
  | { policyIds: string[] }
  | { policy: PolicyDocument }
  | { policySets: PolicySets };

/**
 * What a credential holds its key to, beyond the key's grant: stored policies
 * by id, read as they stand at each check; an inline document (an IAM token);
 * policy sets each check must satisfy (the authority an `On-Behalf-Of`
 * assertion carried); or `all` of those at once. The key's grant ∩ the bound
 * is the most the credential, and any work it starts, may do.
 */
export type PrincipalBound = BoundTerm | { all: BoundTerm[] };

const termsOf = (bound: PrincipalBound): BoundTerm[] => {
  return 'all' in bound ? bound.all : [bound];
};

/** A bound every one of `bounds` holds to. */
export const intersectBounds = (args: {
  bounds: PrincipalBound[];
}): PrincipalBound => {
  const all = args.bounds.flatMap(termsOf);
  return all.length === 1 ? all[0] : { all };
};

/** At least one set, each of valid documents; `[[]]` allows nothing. */
export const isPolicySets = (value: unknown): value is PolicySets => {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((set) => {
      return (
        Array.isArray(set) &&
        set.every((document) => {
          return validatePolicyDocument(document).valid;
        })
      );
    })
  );
};

/** The stored and signed form, as a JWT claim and a JSON column carry it. */
export const serializeBound = (bound: PrincipalBound): object => {
  if ('all' in bound) return { all: bound.all.map(serializeBound) };
  if ('policyIds' in bound) return { policy_ids: bound.policyIds };
  if ('policySets' in bound) return { policy_sets: bound.policySets };
  return { policy: bound.policy };
};

const parseTerm = (value: Record<string, unknown>): BoundTerm | null => {
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
  if (isPolicySets(value.policy_sets)) {
    return { policySets: value.policy_sets };
  }
  const policy = value.policy;
  if (policy !== undefined && validatePolicyDocument(policy).valid) {
    return { policy: policy as PolicyDocument };
  }
  return null;
};

const parseAll = (value: unknown): PrincipalBound | null => {
  if (!Array.isArray(value) || value.length === 0) return null;
  const all: BoundTerm[] = [];
  for (const term of value) {
    const parsed = isPlainObject(term) ? parseTerm(term) : null;
    if (!parsed) return null;
    all.push(parsed);
  }
  return { all };
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
  if (value.all !== undefined) return parseAll(value.all);
  return parseTerm(value);
};
