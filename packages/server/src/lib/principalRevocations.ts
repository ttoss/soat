import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { parsePrincipal } from './iamTokens';

const log = createDebug('soat:principalRevocations');

type OpaquePrincipal = { type: string; id: string };

/**
 * Revokes an opaque principal in a project, for good: work acting for it
 * resolves no caller from then on. Revoking one already revoked is a no-op.
 */
export const revokePrincipal = async (args: {
  projectId: number;
  principal: unknown;
}): Promise<void> => {
  const principal = parsePrincipal(args.principal);
  if (!principal) {
    throw new DomainError('VALIDATION_FAILED', 'principal is required.');
  }
  await db.PrincipalRevocation.findOrCreate({
    where: {
      projectId: args.projectId,
      principalType: principal.type,
      principalId: principal.id,
    },
  });
  log(
    'revokePrincipal: project=%d %s:%s',
    args.projectId,
    principal.type,
    principal.id
  );
};

/** Whether `principal` is revoked in the project `projectPublicId` names. */
export const isPrincipalRevoked = async (args: {
  projectPublicId: string | null;
  principal: OpaquePrincipal;
}): Promise<boolean> => {
  if (!args.projectPublicId) return false;
  const row = await db.PrincipalRevocation.findOne({
    attributes: ['projectId'],
    where: {
      principalType: args.principal.type,
      principalId: args.principal.id,
    },
    include: [
      {
        model: db.Project,
        attributes: [],
        where: { publicId: args.projectPublicId },
        required: true,
      },
    ],
  });
  return row !== null;
};
