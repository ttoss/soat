import jwt from 'jsonwebtoken';

import { JWT_SECRET } from '../middleware/auth';
import { type PrincipalBound, serializeBound } from './principalBound';

/**
 * The credential a manual fire's caller authenticated with, beyond the user:
 * the key that acted, the consent an OAuth token carries, or an IAM token's
 * bound. Each narrows the caller's half of the firing's grant.
 */
export type TriggerCallerCredential = {
  apiKeyPublicId?: string;
  oauthScope?: string;
  bound?: PrincipalBound;
};

/**
 * Mints a short-lived run-as token for a trigger firing, confined to the
 * project (`prj`) and naming the trigger (`trg`). `resolveJwt` grants it the
 * trigger's `policy_ids`: alone for a firing nobody called, the token's user
 * being only the creator it names; intersected with the caller's own grant
 * when `caller` is set (`clr`), the token's user then being that caller. It
 * marks `ctx.authUser.isTriggerToken` so the fire endpoint can reject
 * trigger→trigger recursion.
 */
export const signTriggerToken = (payload: {
  publicId: string;
  role: string;
  projectPublicId: string;
  triggerId: string;
  caller?: TriggerCallerCredential;
}) => {
  const ttl = process.env.SOAT_TRIGGER_TOKEN_TTL || '1h';
  return jwt.sign(
    {
      publicId: payload.publicId,
      role: payload.role,
      prj: payload.projectPublicId,
      trg: payload.triggerId,
      ...(payload.caller
        ? {
            clr: true,
            ...(payload.caller.apiKeyPublicId
              ? { ckey: payload.caller.apiKeyPublicId }
              : {}),
            ...(payload.caller.oauthScope !== undefined
              ? { cscope: payload.caller.oauthScope }
              : {}),
            ...(payload.caller.bound
              ? { cbnd: serializeBound(payload.caller.bound) }
              : {}),
          }
        : {}),
    },
    JWT_SECRET,
    { expiresIn: ttl as jwt.SignOptions['expiresIn'] }
  );
};
