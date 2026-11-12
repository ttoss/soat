import createDebug from 'debug';

import { db } from '../db';
import {
  parseBound,
  type PrincipalBound,
  serializeBound,
} from './principalBound';
import {
  principalFromAuthUser,
  type RequestPrincipal,
  type StartingPrincipal,
} from './principals';
import {
  signToken,
  ttlFromEnv,
  type VerifiedToken,
  verifyToken,
} from './signedTokens';

const log = createDebug('soat:orchestrations');

/**
 * Mints a short-lived run-as token for durable, request-less work, mirroring
 * `triggerToken.ts`. The token carries the starting principal's owning user
 * (`publicId`/`role`), the project the work is confined to (`prj`), and — when
 * an API key started it — that key's public id (`key`), which the auth
 * middleware resolves into the key's policies as a boundary.
 *
 * It asserts *identity* only. Authorization is still evaluated per request
 * against the policies as they stand at that moment, so revoking access takes
 * effect for work already in flight; a token minted at the start that froze
 * permissions would not. It is minted per drive segment rather than stored, so
 * a run sleeping for days never holds a long-lived credential.
 */
export const signRunToken = (payload: {
  publicId: string;
  role: string;
  projectPublicId: string;
  /**
   * The durable work this token acts for: an orchestration run, or the task
   * whose `on_enter` automation dispatched an agent generation. Carried in
   * `orn`, a provenance breadcrumb that is never an authorization input.
   */
  workPublicId: string;
  apiKeyPublicId?: string;
  /** The IAM token bound the work's principal acted under, held again here. */
  bound?: PrincipalBound;
}) => {
  return signToken({
    typ: 'run',
    claims: {
      publicId: payload.publicId,
      role: payload.role,
      prj: payload.projectPublicId,
      orn: payload.workPublicId,
      ...(payload.apiKeyPublicId ? { key: payload.apiKeyPublicId } : {}),
      ...(payload.bound ? { bnd: serializeBound(payload.bound) } : {}),
    },
    expiresIn: ttlFromEnv({ name: 'SOAT_RUN_TOKEN_TTL', fallback: '1h' }),
  });
};

/**
 * Resolves a persisted principal into an `Authorization` header for the platform
 * self-calls the work's `soat` tools make — an orchestration run's tool nodes,
 * or a workflow-dispatched agent's `soat` tool.
 *
 * Returns undefined when there is no principal, or when the principal no longer
 * resolves (a deleted user, a revoked key). The work then proceeds exactly as it
 * did before it had an identity — its self-calls are unauthenticated — except
 * that they now fail loudly instead of storing a 401 body as a result.
 */
export const buildRunAuthHeader = async (args: {
  principal: StartingPrincipal | null | undefined;
  projectId: number;
  workPublicId: string;
}): Promise<string | undefined> => {
  if (!args.principal) return undefined;
  const { principalType: principalKind, principalId, bound } = args.principal;

  const project = await db.Project.findOne({ where: { id: args.projectId } });
  if (!project) return undefined;

  if (principalKind === 'api_key') {
    const apiKey = await db.ApiKey.findOne({
      where: { publicId: principalId },
      include: [{ model: db.User }],
    });
    // A revoked key must not keep acting: without the row there is no boundary
    // to enforce, and minting an owner-only token here would silently widen the
    // run's reach to the whole of that user's access.
    if (!apiKey) {
      log('buildRunAuthHeader: api key %s no longer exists', principalId);
      return undefined;
    }
    const user = apiKey.user;
    if (!user) return undefined;
    return `Bearer ${signRunToken({
      publicId: user.publicId as string,
      role: user.role as string,
      projectPublicId: project.publicId as string,
      workPublicId: args.workPublicId,
      apiKeyPublicId: principalId,
      bound,
    })}`;
  }

  const user = await db.User.findOne({ where: { publicId: principalId } });
  if (!user) {
    log('buildRunAuthHeader: user %s no longer exists', principalId);
    return undefined;
  }
  return `Bearer ${signRunToken({
    publicId: user.publicId as string,
    role: user.role as string,
    projectPublicId: project.publicId as string,
    workPublicId: args.workPublicId,
    bound,
  })}`;
};

/** The principal a run token's or an IAM token's verified claims name. */
const principalOfClaims = (
  payload: VerifiedToken<'run' | 'iam'>
): (RequestPrincipal & { bound?: PrincipalBound }) | null => {
  const bound = parseBound(payload.bnd);
  if (bound === null) return null;
  const boundField = bound ? { bound } : {};
  const keyClaim = payload.key;
  if (typeof keyClaim === 'string') {
    return { principalType: 'api_key', principalId: keyClaim, ...boundField };
  }
  const publicId = payload.publicId;
  if (typeof publicId !== 'string' || payload.typ === 'iam') return null;
  return { principalType: 'user', principalId: publicId, ...boundField };
};

/**
 * Reads the principal back out of a run-as token, so a run started *by another
 * run* (a `loop` or `sub_orchestration` child, which inherits its parent's
 * header) records the same identity its parent had. Without this a nested child
 * would persist no principal, and a crash-redrive of that child — the one path
 * that cannot reuse the parent's in-memory header — would lose its identity.
 *
 * An IAM token reads as its issuing key with the token's bound. Returns null
 * for anything else; a plain user JWT or an `sk_` key is not decoded here,
 * because those call sites pass an explicit principal instead.
 */
export const readRunTokenPrincipal = (
  authHeader: string | undefined
): (RequestPrincipal & { bound?: PrincipalBound }) | null => {
  if (!authHeader?.startsWith('Bearer ')) return null;
  // A trigger token and an OAuth token each carry a boundary living in the
  // *token*, not the principal. Re-minting either as a run token would drop
  // that boundary, so those runs record no principal at all.
  const payload = verifyToken({
    token: authHeader.slice(7),
    accept: ['run', 'iam'],
  });
  return payload ? principalOfClaims(payload) : null;
};

/**
 * The work a run-as token acts for (its `orn`), or null for any other
 * credential. Signed into the tool assertion of every call that work makes,
 * so a write the tool sends back can be traced to it.
 */
export const readRunTokenWork = (
  authHeader: string | undefined
): string | null => {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const payload = verifyToken({ token: authHeader.slice(7), accept: ['run'] });
  return typeof payload?.orn === 'string' ? payload.orn : null;
};

/** The one construction of the brand; every other module receives it. */
const brand = (
  principal: (RequestPrincipal & { bound?: PrincipalBound }) | null
) => {
  return principal as StartingPrincipal | null;
};

/**
 * The principal to persist as having *started* a piece of work, from whichever
 * credential reached it: the authenticated caller when a request started the
 * work, otherwise the run-as token an internal caller was handed. That is what
 * makes a chain durable across hops — each segment reads back the identity the
 * previous one re-minted.
 *
 * A **trigger** and an **OAuth** token deliberately record nothing. Each
 * carries its boundary in the token — the trigger's attached policy, the
 * consented scope — not in the principal, so re-minting a plain run token later
 * would drop that boundary and hand the work the whole of the owning user's
 * access. No principal means self-calls stay unauthenticated, as before.
 */
export const resolveStartingPrincipal = (args: {
  authUser?: {
    publicId: string;
    apiKeyPublicId?: string;
    oauthScope?: string;
    isTriggerToken?: boolean;
    bound?: PrincipalBound;
  };
  authHeader?: string;
}): StartingPrincipal | null => {
  const { authUser } = args;
  if (!authUser) return brand(readRunTokenPrincipal(args.authHeader));
  if (authUser.isTriggerToken) return null;
  if (authUser.bound) {
    return brand({ ...principalFromAuthUser(authUser), bound: authUser.bound });
  }
  if (authUser.oauthScope !== undefined) return null;
  return brand(principalFromAuthUser(authUser));
};

/**
 * A starting principal read back from the columns that recorded one. Those
 * columns are written only from a `StartingPrincipal`, so the rule already ran.
 */
export const readStoredStartingPrincipal = (args: {
  kind: string | null | undefined;
  id: string | null | undefined;
  bound: unknown;
}): StartingPrincipal | null => {
  if ((args.kind !== 'user' && args.kind !== 'api_key') || !args.id) {
    return null;
  }
  const bound = parseBound(args.bound);
  // A bound that no longer parses cannot be held, so the work acts as nobody.
  if (bound === null) return null;
  return brand({
    principalType: args.kind,
    principalId: args.id,
    ...(bound ? { bound } : {}),
  });
};

/** The principal stored in a row's `principal*` columns. */
export const readStoredRunPrincipal = (
  row:
    | {
        principalKind: string | null;
        principalId: string | null;
        principalBound: object | null;
      }
    | null
    | undefined
): StartingPrincipal | null => {
  return readStoredStartingPrincipal({
    kind: row?.principalKind,
    id: row?.principalId,
    bound: row?.principalBound,
  });
};
