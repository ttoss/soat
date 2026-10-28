import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import type { IsAllowedFn } from '../middleware/authProjectResolvers';
import { buildSrn } from './iam';
import { collectSecretRefs } from './secrets';

const log = createDebug('soat:tools');

export const SECRET_USE_ACTION = 'secrets:UseSecret';

/**
 * The secrets a tool sends wherever it points: every `{{secret:...}}` id in
 * its `execute`, `mcp` and `pipeline` (inline steps are tools too). Writing a
 * tool that names one needs `secrets:UseSecret` on it.
 */
export const toolSecretIds = (args: {
  execute?: unknown;
  mcp?: unknown;
  pipeline?: unknown;
}): string[] => {
  return [
    ...new Set(
      collectSecretRefs({
        execute: args.execute,
        mcp: args.mcp,
        pipeline: args.pipeline,
      })
    ),
  ];
};

/**
 * Throws `FORBIDDEN` naming every secret the tool references that `isAllowed`
 * may not use. Asked before the secrets are looked up, so a refused caller
 * learns nothing about which ids exist.
 */
export const assertToolSecretUseAllowed = async (args: {
  tool: { execute?: unknown; mcp?: unknown; pipeline?: unknown };
  projectId: number;
  isAllowed: IsAllowedFn;
}): Promise<void> => {
  const ids = toolSecretIds(args.tool);
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

  log('assertToolSecretUseAllowed: denied secrets=%d', denied.length);
  throw new DomainError(
    'FORBIDDEN',
    `Referencing a secret in a tool requires ${SECRET_USE_ACTION} on it: ${denied.join(', ')}.`,
    { action: SECRET_USE_ACTION, secret_ids: denied }
  );
};
