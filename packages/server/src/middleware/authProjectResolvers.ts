import type { Context } from '../Context';
import type { RefusedBy } from '../lib/authorizationDenial';
import type { PolicySets } from '../lib/iam';
import { extractProjectIdsFromPolicies } from '../lib/iam';

export type IsAllowedFn = ((args: {
  projectPublicId: string;
  action: string;
  resource?: string;
}) => Promise<boolean>) & { refusedBy?: RefusedBy };

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

/** The project ids of `projectPublicIds` (every project when `null`) it may reach. */
const filterAccessibleProjects = async (args: {
  projectPublicIds: string[] | null;
  action: string;
  resourceType?: string;
  isAllowed: IsAllowedFn;
  db: Context['db'];
}): Promise<number[]> => {
  if (args.projectPublicIds?.length === 0) return [];
  const projects = await args.db.Project.findAll(
    args.projectPublicIds ? { where: { publicId: args.projectPublicIds } } : {}
  );
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

/**
 * The projects a grant's sets name, or `null` when one names every project. A
 * grant reaches no project its own sets do not name, whatever caps it.
 */
const projectsNamedByGrant = (sets: PolicySets): string[] | null => {
  const named = new Set<string>();
  for (const docs of sets) {
    const ids = extractProjectIdsFromPolicies(docs);
    if (ids === undefined) return null;
    for (const id of ids) named.add(id);
  }
  return [...named];
};

/**
 * The project ids a request may read for `action`:
 * - a named project → `[id]` when allowed, else `null`;
 * - none named, pinned → the pinned project, probed the same way;
 * - none named, unrestricted → `undefined` (no project filter);
 * - none named otherwise → every project the grant names that it may reach.
 */
export const resolveReachableProjectIds = async (args: {
  projectPublicId?: string;
  action: string;
  resourceType?: string;
  pinned: string | null;
  unrestricted: boolean;
  grantSets: () => Promise<PolicySets>;
  isAllowed: IsAllowedFn;
  db: Context['db'];
}): Promise<number[] | null | undefined> => {
  const named = args.projectPublicId ?? args.pinned;
  if (named !== null) {
    if (args.pinned !== null && named !== args.pinned) return null;
    const [id] = await filterAccessibleProjects({
      ...args,
      projectPublicIds: [named],
    });
    return id === undefined ? null : [id];
  }
  if (args.unrestricted) return undefined;
  return filterAccessibleProjects({
    ...args,
    projectPublicIds: projectsNamedByGrant(await args.grantSets()),
  });
};
