import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';

import { resolveReadProjectIds, resolveWriteProjectPublicId } from './helpers';

/**
 * How a list route reads `?project_id`:
 * - `optional`: narrows to that project; absent, the list spans every project
 *   the caller reads (an unrestricted admin: every project).
 * - `implied`: names the one project the route reads, else a project-bound
 *   credential's own; neither is `400`.
 * - `none`: the route declares no selector and spans every project the caller
 *   reads.
 */
export type ProjectSelector = 'optional' | 'implied' | 'none';

export type ListScope = {
  /** `undefined` is no project filter; `[]` matches no project. */
  projectIds: number[] | undefined;
  projectPublicId: string | undefined;
};

const queryProjectPublicId = (ctx: Context): string | undefined => {
  const value = ctx.query.project_id;
  if (Array.isArray(value)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'project_id must be a single value.'
    );
  }
  return value || undefined;
};

const selectedProjectPublicId = (args: {
  ctx: Context;
  projectSelector: ProjectSelector;
}): string | undefined => {
  if (args.projectSelector === 'none') return undefined;
  const projectPublicId = queryProjectPublicId(args.ctx);
  if (args.projectSelector === 'implied') {
    return resolveWriteProjectPublicId({ ctx: args.ctx, projectPublicId });
  }
  return projectPublicId;
};

/**
 * The project scope of every list route. `projectSelector` is required, so a
 * new list states whether it spans projects. A caller permitted in no project
 * gets `[]`, an empty page, never a `403`;
 * `tests/harness/listScopeChokepoint.test.mjs` holds list routes to it.
 */
export const resolveListScope = async (args: {
  ctx: Context;
  action: string;
  resourceType: string;
  projectSelector: ProjectSelector;
}): Promise<ListScope> => {
  const projectPublicId = selectedProjectPublicId(args);
  const projectIds = await resolveReadProjectIds({
    ctx: args.ctx,
    projectPublicId,
    action: args.action,
    resourceType: args.resourceType,
  });

  return { projectIds, projectPublicId };
};
