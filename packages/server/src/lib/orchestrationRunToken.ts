import createDebug from 'debug';
import jwt from 'jsonwebtoken';

import { db } from '../db';
import { JWT_SECRET } from '../middleware/auth';
import type { RequestPrincipal } from './principals';

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
   * whose `on_enter` automation dispatched an agent generation (#884). Carried
   * in `orn`, whose *presence* is what marks a run-as token; the value itself
   * is a provenance breadcrumb and is never an authorization input.
   */
  workPublicId: string;
  apiKeyPublicId?: string;
}) => {
  const ttl = process.env.SOAT_RUN_TOKEN_TTL || '1h';
  return jwt.sign(
    {
      publicId: payload.publicId,
      role: payload.role,
      prj: payload.projectPublicId,
      // `orn` marks this as a run token, the way `trg` marks a trigger one.
      // Without a marker the middleware cannot tell a project-scoped run token
      // from an OAuth access token, and would build a consent boundary out of
      // this token's (absent) `scope` claim — an allow-nothing policy.
      orn: payload.workPublicId,
      ...(payload.apiKeyPublicId ? { key: payload.apiKeyPublicId } : {}),
    },
    JWT_SECRET,
    { expiresIn: ttl as jwt.SignOptions['expiresIn'] }
  );
};

/**
 * Resolves a persisted principal into an `Authorization` header for the platform
 * self-calls the work's `soat` tools make — an orchestration run's tool nodes,
 * or a workflow-dispatched agent's `soat` tool (#884).
 *
 * Returns undefined when there is no principal, or when the principal no longer
 * resolves (a deleted user, a revoked key). The work then proceeds exactly as it
 * did before it had an identity — its self-calls are unauthenticated — except
 * that they now fail loudly instead of storing a 401 body as a result.
 */
export const buildRunAuthHeader = async (args: {
  principalKind: string | null;
  principalId: string | null;
  projectId: number;
  workPublicId: string;
}): Promise<string | undefined> => {
  const { principalKind, principalId } = args;
  if (!principalKind || !principalId) return undefined;

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
  })}`;
};

/**
 * Reads the principal back out of a run-as token, so a run started *by another
 * run* (a `loop` or `sub_orchestration` child, which inherits its parent's
 * header) records the same identity its parent had. Without this a nested child
 * would persist no principal, and a crash-redrive of that child — the one path
 * that cannot reuse the parent's in-memory header — would lose its identity.
 *
 * Returns null for anything that is not one of our own run tokens; a plain user
 * JWT or an `sk_` key is not decoded here, because those call sites pass an
 * explicit principal instead.
 */
export const readRunTokenPrincipal = (
  authHeader: string | undefined
): RequestPrincipal | null => {
  if (!authHeader?.startsWith('Bearer ')) return null;
  try {
    const payload = jwt.verify(authHeader.slice(7), JWT_SECRET);
    if (typeof payload === 'string') return null;

    // Identified by the `orn` marker, so nothing else is mistaken for one. In
    // particular a trigger run-as token (`trg`) and an OAuth access token
    // (`scope`) each carry a boundary that lives in the *token*, not in the
    // principal: the trigger's attached policy, the consented scope. Re-minting
    // either as a plain run token later would drop that boundary and hand the
    // run more access than the credential that started it, so those runs record
    // no principal at all and keep today's behaviour instead.
    if (typeof payload.orn !== 'string') return null;

    const keyClaim = payload.key;
    if (typeof keyClaim === 'string') {
      return { principalType: 'api_key', principalId: keyClaim };
    }
    const publicId = payload.publicId;
    if (typeof publicId !== 'string') return null;
    return { principalType: 'user', principalId: publicId };
  } catch {
    return null;
  }
};
