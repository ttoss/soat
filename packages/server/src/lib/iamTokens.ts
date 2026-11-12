import { randomUUID } from 'node:crypto';

import createDebug from 'debug';

import type { AuthUser } from '../Context';
import { db } from '../db';
import { DomainError } from '../errors';
import {
  type PolicyDocument,
  validatePolicyActions,
  validatePolicyDocument,
} from './iam';
import { isPlainObject } from './plainObject';
import { type PrincipalBound, serializeBound } from './principalBound';
import { signToken } from './signedTokens';

const log = createDebug('soat:iamTokens');

export const IAM_TOKEN_ACTION = 'iam:CreateToken';

/** Seconds an IAM token lives: `ttl_seconds` is held to this range. */
export const IAM_TOKEN_TTL = { min: 30, max: 900, default: 300 } as const;

const PRINCIPAL_FIELD_MAX = 255;

type Issuer = {
  publicId: string;
  role: string;
  apiKeyPublicId: string;
  projectId: number;
  projectPublicId: string;
};

/**
 * Only an API key scoped to one project issues a token: the token is that key
 * held to a bound, so a user login, an unscoped key and every project-scoped
 * token (OAuth, trigger, run, IAM) are refused. A key narrowed by
 * `On-Behalf-Of` is refused too: the token would not carry that narrowing.
 */
export const assertIamTokenIssuer = (args: {
  authUser: AuthUser;
  onRefused: () => void;
}): Issuer => {
  const { authUser } = args;
  const { apiKeyPublicId, apiKeyProjectId, apiKeyProjectPublicId } = authUser;
  if (
    !apiKeyPublicId ||
    apiKeyProjectId === undefined ||
    !apiKeyProjectPublicId ||
    authUser.oauthProjectPublicId !== undefined ||
    authUser.onBehalfOf
  ) {
    log('assertIamTokenIssuer: refused user=%s', authUser.publicId);
    args.onRefused();
    throw new DomainError(
      'IAM_TOKEN_ISSUER_NOT_ALLOWED',
      'Only an API key scoped to a project issues an IAM token.'
    );
  }
  return {
    publicId: authUser.publicId,
    role: authUser.role,
    apiKeyPublicId,
    projectId: apiKeyProjectId,
    projectPublicId: apiKeyProjectPublicId,
  };
};

const policyInvalid = (message: string, errors?: string[]) => {
  return new DomainError(
    'IAM_TOKEN_POLICY_INVALID',
    message,
    errors ? { errors } : undefined
  );
};

const parsePolicyIds = async (args: {
  policyIds: unknown;
  issuer: Issuer;
}): Promise<PrincipalBound> => {
  const { policyIds } = args;
  if (
    !Array.isArray(policyIds) ||
    policyIds.length === 0 ||
    !policyIds.every((id) => {
      return typeof id === 'string';
    })
  ) {
    throw policyInvalid('policy_ids must be a non-empty list of policy ids.');
  }
  const ids = [...new Set(policyIds)];
  const rows = await db.Policy.findAll({
    where: { publicId: ids },
    attributes: ['publicId', 'projectId'],
  });
  const usable = new Set(
    rows
      .filter((row) => {
        return (
          row.projectId === null || row.projectId === args.issuer.projectId
        );
      })
      .map((row) => {
        return row.publicId as string;
      })
  );
  const unknown = ids.find((id) => {
    return !usable.has(id);
  });
  if (unknown) {
    throw policyInvalid(
      `Policy '${unknown}' is not a policy of this project or a global one.`
    );
  }
  return { policyIds: ids };
};

const parsePolicy = (args: { policy: unknown }): PrincipalBound => {
  if (!isPlainObject(args.policy)) {
    throw policyInvalid('policy must be a policy document.');
  }
  const document = args.policy as PolicyDocument;
  // No project check on `Allow` resources: the token never leaves its project.
  const structural = validatePolicyDocument(document);
  const validation = structural.valid
    ? validatePolicyActions(document)
    : structural;
  if (!validation.valid) {
    throw policyInvalid(
      'policy is not a valid policy document.',
      validation.errors
    );
  }
  return { policy: document };
};

const parseBoundBody = async (args: {
  body: Record<string, unknown>;
  issuer: Issuer;
}): Promise<PrincipalBound> => {
  const { policy_ids: policyIds, policy } = args.body;
  if ((policy === undefined) === (policyIds === undefined)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'Send exactly one of policy and policy_ids.'
    );
  }
  return policy === undefined
    ? parsePolicyIds({ policyIds, issuer: args.issuer })
    : parsePolicy({ policy });
};

const parsePrincipal = (
  value: unknown
): { type: string; id: string } | undefined => {
  if (value === undefined) return undefined;
  const valid = (field: unknown): field is string => {
    return (
      typeof field === 'string' &&
      field.length > 0 &&
      field.length <= PRINCIPAL_FIELD_MAX
    );
  };
  if (!isPlainObject(value) || !valid(value.type) || !valid(value.id)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `principal must be { type, id }, each a string of 1 to ${PRINCIPAL_FIELD_MAX} characters.`
    );
  }
  return { type: value.type, id: value.id };
};

const parseTtl = (value: unknown): number => {
  if (value === undefined) return IAM_TOKEN_TTL.default;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < IAM_TOKEN_TTL.min ||
    value > IAM_TOKEN_TTL.max
  ) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `ttl_seconds must be an integer from ${IAM_TOKEN_TTL.min} to ${IAM_TOKEN_TTL.max}.`
    );
  }
  return value;
};

/**
 * Issues a token that is the issuing key held to a bound: every request on it
 * is checked against the key's grant as it stands then ∩ the bound, and work
 * it starts keeps the bound after it expires.
 */
export const createIamToken = async (args: {
  issuer: Issuer;
  body: Record<string, unknown>;
}): Promise<{ token: string; expires_at: string }> => {
  const { issuer, body } = args;
  const bound = await parseBoundBody({ body, issuer });
  const principal = parsePrincipal(body.principal);
  const ttlSeconds = parseTtl(body.ttl_seconds);
  const jti = randomUUID();
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + ttlSeconds;
  const token = signToken({
    typ: 'iam',
    claims: {
      publicId: issuer.publicId,
      role: issuer.role,
      prj: issuer.projectPublicId,
      key: issuer.apiKeyPublicId,
      bnd: serializeBound(bound),
      ...(principal ? { prn: principal } : {}),
      jti,
      iat: issuedAt,
    },
    expiresIn: ttlSeconds,
  });
  log(
    'createIamToken: key=%s jti=%s ttl=%d',
    issuer.apiKeyPublicId,
    jti,
    ttlSeconds
  );
  return { token, expires_at: new Date(expiresAt * 1000).toISOString() };
};
