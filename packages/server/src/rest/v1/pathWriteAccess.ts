import type { Context } from 'src/Context';
import { callerDenied } from 'src/lib/authorizationDenial';
import { buildSrn } from 'src/lib/iam';
import { pathAddressedResourceTypes } from 'src/lib/policyCompiler';
import { buildResourceTagContext } from 'src/lib/tags';

import { requireAuth, resolveWriteProjectId } from './helpers';

type PathWrite = {
  ctx: Context;
  action: string;
  resourceType: string;
  /** Derives the path the write stores, with the function the store uses. */
  key: () => string | null;
};

/**
 * The key a write names, read before it is authorized. A write with no path,
 * or a key that cannot be read, is judged on `{type}:*`, so a caller without
 * the action learns nothing about it; the refusal is thrown once allowed.
 */
const readKey = (
  args: PathWrite
): { path: string | null; refusal?: unknown } => {
  if (!pathAddressedResourceTypes().includes(args.resourceType)) {
    throw new Error(`'${args.resourceType}' declares no pathColumn`);
  }
  try {
    return { path: args.key() };
  } catch (error) {
    return { path: null, refusal: error };
  }
};

/**
 * The project a write to a path-addressed type lands in, authorized on the SRN
 * of the path it writes (`srn:{project}:{type}:{path}`), so a grant on a
 * directory admits the writes under it and no others. Every such write
 * resolves its project here (`tests/harness/pathWriteAccess.test.mjs`).
 */
export const resolvePathWriteProjectId = async (
  args: PathWrite & { projectPublicId?: string }
): Promise<number> => {
  requireAuth(args.ctx);
  const key = readKey(args);
  const projectId = await resolveWriteProjectId({
    ctx: args.ctx,
    projectPublicId: args.projectPublicId,
    action: args.action,
    resourceType: args.resourceType,
    resourceId: key.path ?? undefined,
  });
  if ('refusal' in key) throw key.refusal;
  return projectId;
};

/**
 * A move of an existing resource, authorized on its destination path in its
 * own project, under the moved resource's tags; the route checks the resource
 * itself first.
 */
export const assertPathMoveAllowed = async (
  args: PathWrite & {
    projectPublicId: string;
    tags: Record<string, string> | null | undefined;
  }
): Promise<void> => {
  requireAuth(args.ctx);
  const key = readKey(args);
  const resource = buildSrn({
    projectPublicId: args.projectPublicId,
    resourceType: args.resourceType,
    resourceId: key.path ?? '*',
  });
  const allowed = await args.ctx.authUser.isAllowed({
    projectPublicId: args.projectPublicId,
    action: args.action,
    resources: [resource],
    context: buildResourceTagContext({
      resourceType: args.resourceType,
      tags: args.tags,
    }),
  });
  if (!allowed) {
    throw callerDenied({
      authUser: args.ctx.authUser,
      action: args.action,
      resource,
    });
  }
  if ('refusal' in key) throw key.refusal;
};
