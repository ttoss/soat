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
 * (`srn:{project}:{type}:*`) so resource-scoped policies are enforced; without
 * one it falls back to the project-wildcard (`srn:{project}:*:*`), used only
 * where the project itself is the target.
 */
const scopingSrn = (projectPublicId: string, resourceType?: string): string => {
  return resourceType
    ? `srn:${projectPublicId}:${resourceType}:*`
    : `srn:${projectPublicId}:*:*`;
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

const findProjectIds = async (args: {
  projectPublicId: string;
  action: string;
  resourceType?: string;
  isAllowed: IsAllowedFn;
  db: Context['db'];
}): Promise<number[] | null> => {
  const allowed = await args.isAllowed({
    projectPublicId: args.projectPublicId,
    action: args.action,
    resource: scopingSrn(args.projectPublicId, args.resourceType),
  });
  if (!allowed) return null;
  const proj = await args.db.Project.findOne({
    where: { publicId: args.projectPublicId },
  });
  if (!proj) return null;
  return [proj.id as number];
};

/** The projects `policyIds` name, or null when one names every project. */
const projectsNamedByPolicies = async (args: {
  policyIds: number[];
  db: Context['db'];
}): Promise<string[] | null> => {
  if (args.policyIds.length === 0) return [];
  const policies = await args.db.Policy.findAll({
    where: { id: args.policyIds },
  });
  const policyDocs = policies.map(
    (p: InstanceType<(typeof args.db)['Policy']>) => {
      return p.document as PolicyDocument;
    }
  );
  return extractProjectIdsFromPolicies(policyDocs) ?? null;
};

type ResolveArgs = {
  projectPublicId?: string;
  action: string;
  resourceType?: string;
};

/** `resolveProjectIds` for a credential confined to one project. */
export const createPinnedResolveProjectIds = (args: {
  pinnedProjectPublicId: string;
  isAllowed: IsAllowedFn;
  db: Context['db'];
}) => {
  return async (req: ResolveArgs): Promise<number[] | null | undefined> => {
    if (
      req.projectPublicId &&
      req.projectPublicId !== args.pinnedProjectPublicId
    ) {
      return null;
    }
    return findProjectIds({
      projectPublicId: args.pinnedProjectPublicId,
      action: req.action,
      resourceType: req.resourceType,
      isAllowed: args.isAllowed,
      db: args.db,
    });
  };
};

/**
 * `resolveProjectIds` for a credential bound to no project:
 * - explicit project → verify it, return [id] or null.
 * - no project and `everyProject` → `undefined` (no filter).
 * - no project otherwise → every project it can reach, probing the projects
 *   `candidatePolicyIds` name, or every project when `'all'`.
 */
export const createUnpinnedResolveProjectIds = (args: {
  everyProject: boolean;
  candidatePolicyIds: number[] | 'all';
  isAllowed: IsAllowedFn;
  db: Context['db'];
}) => {
  return async (req: ResolveArgs): Promise<number[] | null | undefined> => {
    if (req.projectPublicId) {
      return findProjectIds({
        projectPublicId: req.projectPublicId,
        action: req.action,
        resourceType: req.resourceType,
        isAllowed: args.isAllowed,
        db: args.db,
      });
    }
    if (args.everyProject) return undefined;
    const candidates =
      args.candidatePolicyIds === 'all'
        ? null
        : await projectsNamedByPolicies({
            policyIds: args.candidatePolicyIds,
            db: args.db,
          });
    if (candidates !== null && candidates.length === 0) return [];
    return filterAccessibleProjects({
      projectPublicIds: candidates,
      action: req.action,
      resourceType: req.resourceType,
      isAllowed: args.isAllowed,
      db: args.db,
    });
  };
};
