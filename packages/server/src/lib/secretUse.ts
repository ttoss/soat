import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import type { IsAllowedFn } from '../middleware/authProjectResolvers';
import { buildSrn } from './iam';
import { collectSecretRefs } from './secrets';

const log = createDebug('soat:secrets');

export const SECRET_USE_ACTION = 'secrets:UseSecret';

/** Every distinct `{{secret:...}}` id in `value`. */
export const secretRefIds = (value: unknown): string[] => {
  return [...new Set(collectSecretRefs(value))];
};

/**
 * The secrets a tool sends wherever it points: every `{{secret:...}}` id in
 * its `execute`, `mcp` and `pipeline` (inline steps are tools too).
 */
export const toolSecretIds = (args: {
  execute?: unknown;
  mcp?: unknown;
  pipeline?: unknown;
}): string[] => {
  return secretRefIds({
    execute: args.execute,
    mcp: args.mcp,
    pipeline: args.pipeline,
  });
};

/**
 * The one gate for a write that stores a secret the server later sends
 * outward: throws `FORBIDDEN` naming every id in `secretIds` that `isAllowed`
 * may not use. Asked before the secrets are looked up, so a refused caller
 * learns nothing about which ids exist.
 */
export const assertSecretUseAllowed = async (args: {
  secretIds: string[];
  projectId: number;
  isAllowed: IsAllowedFn;
}): Promise<void> => {
  const ids = [...new Set(args.secretIds)];
  if (ids.length === 0) return;

  const project = await db.Project.findByPk(args.projectId, {
    attributes: ['publicId'],
    rejectOnEmpty: true,
  });

  const denied: string[] = [];
  for (const id of ids) {
    const allowed = await args.isAllowed({
      projectPublicId: project.publicId,
      action: SECRET_USE_ACTION,
      resource: buildSrn({
        projectPublicId: project.publicId,
        resourceType: 'secret',
        resourceId: id,
      }),
    });
    if (!allowed) denied.push(id);
  }
  if (denied.length === 0) return;

  log('assertSecretUseAllowed: denied secrets=%d', denied.length);
  throw new DomainError(
    'FORBIDDEN',
    `Referencing a secret requires ${SECRET_USE_ACTION} on it: ${denied.join(', ')}.`,
    { action: SECRET_USE_ACTION, secret_ids: denied }
  );
};

/** {@link assertSecretUseAllowed} over the secrets a tool definition names. */
export const assertToolSecretUseAllowed = (args: {
  tool: { execute?: unknown; mcp?: unknown; pipeline?: unknown };
  projectId: number;
  isAllowed: IsAllowedFn;
}): Promise<void> => {
  return assertSecretUseAllowed({
    secretIds: toolSecretIds(args.tool),
    projectId: args.projectId,
    isAllowed: args.isAllowed,
  });
};
