import jwt from 'jsonwebtoken';

import { JWT_SECRET } from '../middleware/auth';

/**
 * Mints a short-lived run-as token for a trigger firing. The token carries the
 * creator's identity (`publicId`/`role`), the project it is confined to (`prj`),
 * and the trigger id (`trg`). The auth middleware's `resolveJwt` resolves it
 * exactly like a project-scoped credential — creator's current policies
 * (ceiling) ∩ the trigger's attached policy (boundary), hard-confined to the
 * project — and marks `ctx.authUser.isTriggerToken` so the fire endpoint can
 * reject trigger→trigger recursion.
 */
export const signTriggerToken = (payload: {
  publicId: string;
  role: string;
  projectPublicId: string;
  triggerId: string;
}) => {
  const ttl = process.env.SOAT_TRIGGER_TOKEN_TTL || '1h';
  return jwt.sign(
    {
      publicId: payload.publicId,
      role: payload.role,
      prj: payload.projectPublicId,
      trg: payload.triggerId,
    },
    JWT_SECRET,
    { expiresIn: ttl as jwt.SignOptions['expiresIn'] }
  );
};
