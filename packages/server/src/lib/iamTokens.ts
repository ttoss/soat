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
import { carriesDenial } from './policyDenial';
import { type PrincipalBound, serializeBound } from './principalBound';
import { signToken } from './signedTokens';
import { parseToolContextLayer } from './toolContextLayer';

const log = createDebug('soat:iamTokens');

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

const refuseIssuer = (args: {
  authUser: AuthUser;
  onRefused: () => void;
  message?: string;
}): DomainError => {
  log('assertIamTokenIssuer: refused user=%s', args.authUser.publicId);
  args.onRefused();
  return new DomainError(
    'IAM_TOKEN_ISSUER_NOT_ALLOWED',
    args.message ??
      'Only an API key scoped to a project or to a group issues an IAM token.'
  );
};

/**
 * The project a group key's token acts in: `project_id`, a project of the
 * key's group. A token acts in one project, whatever key issued it.
 */
const groupKeyProject = async (args: {
  authUser: AuthUser;
  projectId: unknown;
  onRefused: () => void;
}): Promise<{ id: number; publicId: string }> => {
  const project =
    typeof args.projectId === 'string'
      ? await db.Project.findOne({
          where: {
            publicId: args.projectId,
            groupId: args.authUser.apiKeyGroupId,
          },
          attributes: ['id', 'publicId'],
        })
      : null;
  if (!project) {
    throw refuseIssuer({
      ...args,
      message:
        'A group key issues an IAM token for project_id, a project of its group.',
    });
  }
  return { id: project.id as number, publicId: project.publicId as string };
};

/** The project the token acts in: a project key's own, or a group key's pick. */
const issuerProject = async (args: {
  authUser: AuthUser;
  projectId: unknown;
  onRefused: () => void;
}): Promise<{ id: number; publicId: string }> => {
  const { apiKeyProjectId, apiKeyProjectPublicId } = args.authUser;
  if (apiKeyProjectId !== undefined && apiKeyProjectPublicId) {
    if (
      args.projectId !== undefined &&
      args.projectId !== apiKeyProjectPublicId
    ) {
      throw refuseIssuer({
        ...args,
        message: 'A project key issues an IAM token for its own project only.',
      });
    }
    return { id: apiKeyProjectId, publicId: apiKeyProjectPublicId };
  }
  if (args.authUser.apiKeyGroupId === undefined) throw refuseIssuer(args);
  return groupKeyProject(args);
};

/**
 * Only an API key scoped to one project, or to a group for `projectId` in it,
 * issues a token: the token is that key held to a bound and pinned to that
 * project, so a user login, an unscoped key and every project-scoped token
 * (OAuth, IAM) are refused. A key narrowed by `On-Behalf-Of` is refused too:
 * the token would not carry that narrowing.
 */
export const assertIamTokenIssuer = async (args: {
  authUser: AuthUser;
  projectId: unknown;
  onRefused: () => void;
}): Promise<Issuer> => {
  const { authUser } = args;
  const { apiKeyPublicId, publicId, role } = authUser;
  if (
    !publicId ||
    !role ||
    !apiKeyPublicId ||
    authUser.oauthProjectPublicId !== undefined ||
    authUser.onBehalfOf
  ) {
    throw refuseIssuer(args);
  }
  const project = await issuerProject(args);
  return {
    publicId,
    role,
    apiKeyPublicId,
    projectId: project.id,
    projectPublicId: project.publicId,
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
  // A denial is written only on a stored policy, by an unrestricted admin.
  if (carriesDenial(document)) {
    throw policyInvalid('policy may not carry a statement denial.');
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
      'policy and policy_ids are mutually exclusive, and one is required.'
    );
  }
  return policy === undefined
    ? parsePolicyIds({ policyIds, issuer: args.issuer })
    : parsePolicy({ policy });
};

/** An opaque `{ type, id }` principal from a request body; absent is invalid. */
export const requirePrincipal = (
  value: unknown
): { type: string; id: string } => {
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

/** An opaque `{ type, id }` principal from a request body; absent is undefined. */
export const parsePrincipal = (
  value: unknown
): { type: string; id: string } | undefined => {
  return value === undefined ? undefined : requirePrincipal(value);
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
 * The issuing key held to `bound`, as an IAM token: every request on it is
 * checked against the key's grant as it stands then ∩ the bound, and work it
 * starts stores the bound and its `tool_context` layer.
 */
export const signIamToken = (args: {
  issuer: Pick<
    Issuer,
    'publicId' | 'role' | 'apiKeyPublicId' | 'projectPublicId'
  >;
  bound: PrincipalBound;
  principal?: { type: string; id: string };
  toolContext?: Record<string, string>;
  ttlSeconds: number;
}): { token: string; jti: string; expiresAt: number } => {
  const { issuer, principal, toolContext } = args;
  const jti = randomUUID();
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = signToken({
    typ: 'iam',
    claims: {
      publicId: issuer.publicId,
      role: issuer.role,
      prj: issuer.projectPublicId,
      key: issuer.apiKeyPublicId,
      bnd: serializeBound(args.bound),
      ...(principal ? { prn: principal } : {}),
      ...(toolContext ? { tcx: toolContext } : {}),
      jti,
      iat: issuedAt,
    },
    expiresIn: args.ttlSeconds,
  });
  return { token, jti, expiresAt: issuedAt + args.ttlSeconds };
};

/** Issues an IAM token for `POST /iam/tokens`; its bound outlives it. */
export const createIamToken = async (args: {
  issuer: Issuer;
  body: Record<string, unknown>;
  /** The body's `tool_context`, read by `parseToolContextBody`. */
  toolContext: Record<string, string> | undefined;
  /** Whether the issuer's grant allows `iam:PinReservedToolContext`. */
  mayPinReserved: boolean;
}): Promise<{ token: string; jti: string; expires_at: string }> => {
  const { issuer, body } = args;
  const ttlSeconds = parseTtl(body.ttl_seconds);
  const { token, jti, expiresAt } = signIamToken({
    issuer,
    bound: await parseBoundBody({ body, issuer }),
    principal: parsePrincipal(body.principal),
    toolContext: parseToolContextLayer({
      toolContext: args.toolContext,
      mayPinReserved: args.mayPinReserved,
    }),
    ttlSeconds,
  });
  log(
    'createIamToken: key=%s jti=%s ttl=%d layer=%s',
    issuer.apiKeyPublicId,
    jti,
    ttlSeconds,
    args.toolContext === undefined ? 'none' : 'set'
  );
  return {
    token,
    jti,
    expires_at: new Date(expiresAt * 1000).toISOString(),
  };
};
