import type { Context } from '../Context';
import type { PolicyDocument } from '../lib/iam';
import { extractProjectIdsFromPolicies } from '../lib/iam';

export type IsAllowedFn = (args: {
  projectPublicId: string;
  action: string;
  resource?: string;
}) => Promise<boolean>;

/**
 * SRN used to probe project accessibility for a list/scoping check. When a
 * `resourceType` is known the probe is scoped to the type
 * (`soat:{project}:{type}:*`) so resource-scoped policies are enforced; without
 * one it falls back to the project-wildcard (`soat:{project}:*:*`), used only
 * where the project itself is the target.
 */
const scopingSrn = (projectPublicId: string, resourceType?: string): string => {
  return resourceType
    ? `soat:${projectPublicId}:${resourceType}:*`
    : `soat:${projectPublicId}:*:*`;
};

const filterAccessibleProjects = async (args: {
  projectPublicIds: string[] | null;
  action: string;
  resourceType?: string;
  isAllowed: IsAllowedFn;
  db: Context['db'];
}): Promise<number[]> => {
  const projects = args.projectPublicIds
    ? await args.db.Project.findAll({
        where: { publicId: args.projectPublicIds },
      })
    : await args.db.Project.findAll();

  const accessible: number[] = [];
  for (const proj of projects) {
    const allowed = await args.isAllowed({
      projectPublicId: proj.publicId as string,
      action: args.action,
      resource: scopingSrn(proj.publicId as string, args.resourceType),
    });
    if (allowed) accessible.push(proj.id as number);
  }
  return accessible;
};

const resolveProjectIdsByPublicIdAndPolicy = async (args: {
  reqProjectPublicId?: string;
  action: string;
  resourceType?: string;
  isAllowed: IsAllowedFn;
  policyIds: number[];
  db: Context['db'];
}): Promise<number[] | null> => {
  if (args.reqProjectPublicId) {
    const allowed = await args.isAllowed({
      projectPublicId: args.reqProjectPublicId,
      action: args.action,
      resource: scopingSrn(args.reqProjectPublicId, args.resourceType),
    });
    if (!allowed) return null;
    const proj = await args.db.Project.findOne({
      where: { publicId: args.reqProjectPublicId },
    });
    if (!proj) return null;
    return [proj.id as number];
  }

  if (args.policyIds.length === 0) return [];

  const policies = await args.db.Policy.findAll({
    where: { id: args.policyIds },
  });
  const policyDocs = policies.map(
    (p: InstanceType<(typeof args.db)['Policy']>) => {
      return p.document as PolicyDocument;
    }
  );
  const projectPublicIds = extractProjectIdsFromPolicies(policyDocs);

  if (projectPublicIds != null && projectPublicIds.length === 0) return [];

  return filterAccessibleProjects({
    projectPublicIds: projectPublicIds ?? null,
    action: args.action,
    resourceType: args.resourceType,
    isAllowed: args.isAllowed,
    db: args.db,
  });
};

const resolveApiKeyScopedProjectIds = async (args: {
  apiKeyProjectPublicId: string;
  reqProjectPublicId?: string;
  action: string;
  resourceType?: string;
  apiKeyIsAllowed: IsAllowedFn;
  db: Context['db'];
}): Promise<number[] | null> => {
  const targetId = args.reqProjectPublicId ?? args.apiKeyProjectPublicId;
  if (
    args.reqProjectPublicId &&
    args.reqProjectPublicId !== args.apiKeyProjectPublicId
  )
    return null;
  const allowed = await args.apiKeyIsAllowed({
    projectPublicId: targetId,
    action: args.action,
    resource: scopingSrn(targetId, args.resourceType),
  });
  if (!allowed) return null;
  const proj = await args.db.Project.findOne({ where: { publicId: targetId } });
  if (!proj) return null;
  return [proj.id as number];
};

// Both call sites (a real API key's `resolveProjectIds`, and an OAuth
// token's when its consented scope carries a project) only construct this
// with a project already resolved: a scoped API key carries a project id, and
// the OAuth call site is itself gated on `oauthProjectPublicId` being set. So
// `apiKeyProjectPublicId` is always defined here — unscoped keys use
// `createUnscopedApiKeyResolveProjectIds` instead.
export const createApiKeyResolveProjectIds = (args: {
  apiKeyProjectPublicId: string;
  apiKeyIsAllowed: IsAllowedFn;
  db: Context['db'];
}) => {
  return async ({
    projectPublicId: reqId,
    action,
    resourceType,
  }: {
    projectPublicId?: string;
    action: string;
    resourceType?: string;
  }): Promise<number[] | null | undefined> => {
    return resolveApiKeyScopedProjectIds({
      apiKeyProjectPublicId: args.apiKeyProjectPublicId,
      reqProjectPublicId: reqId,
      action,
      resourceType,
      apiKeyIsAllowed: args.apiKeyIsAllowed,
      db: args.db,
    });
  };
};

/**
 * `resolveProjectIds` for an UNSCOPED API key (null projectId). The key is not
 * confined to a project, so behaviour mirrors a plain user credential but runs
 * through the key's own authorizer — which already intersects the owner's
 * permissions with the key's attached policies:
 * - explicit project → verify via the key authorizer, return [id] or null.
 * - no project + full admin inheritance (admin owner, no key policies) →
 *   `undefined` (no filter — every project).
 * - no project otherwise → enumerate every project the key can actually reach.
 */
export const createUnscopedApiKeyResolveProjectIds = (args: {
  userRole: 'admin' | 'user';
  hasKeyBoundary: boolean;
  apiKeyIsAllowed: IsAllowedFn;
  db: Context['db'];
}) => {
  return async ({
    projectPublicId: reqId,
    action,
    resourceType,
  }: {
    projectPublicId?: string;
    action: string;
    resourceType?: string;
  }): Promise<number[] | null | undefined> => {
    if (reqId) {
      const allowed = await args.apiKeyIsAllowed({
        projectPublicId: reqId,
        action,
        resource: scopingSrn(reqId, resourceType),
      });
      if (!allowed) return null;
      const proj = await args.db.Project.findOne({
        where: { publicId: reqId },
      });
      if (!proj) return null;
      return [proj.id as number];
    }

    if (args.userRole === 'admin' && !args.hasKeyBoundary) return undefined;

    return filterAccessibleProjects({
      projectPublicIds: null,
      action,
      resourceType,
      isAllowed: args.apiKeyIsAllowed,
      db: args.db,
    });
  };
};

/** Builds the `resolveProjectIds` implementation for a plain (unscoped) user JWT. */
export const createJwtResolveProjectIds = (args: {
  role: 'admin' | 'user';
  userPolicyIds: number[];
  jwtIsAllowed: IsAllowedFn;
  db: Context['db'];
}) => {
  return async ({
    projectPublicId,
    action,
    resourceType,
  }: {
    projectPublicId?: string;
    action: string;
    resourceType?: string;
  }) => {
    if (args.role === 'admin' && !projectPublicId) return undefined;
    return resolveProjectIdsByPublicIdAndPolicy({
      reqProjectPublicId: projectPublicId,
      action,
      resourceType,
      isAllowed: args.jwtIsAllowed,
      policyIds: args.userPolicyIds,
      db: args.db,
    });
  };
};
