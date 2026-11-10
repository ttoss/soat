import type { PolicyDocument, PolicySets } from './iam';

// Sentinel distinguishing "this statement grants access to all projects" from
// a (possibly empty) list of specific project ids, without reusing `undefined`
// (which already means something different one level up).
const ALL_PROJECTS = Symbol('ALL_PROJECTS');

/**
 * The project segment one resource pattern names: ALL_PROJECTS for `*` or
 * `srn:*:…`, `null` for a pattern that is not a full SRN.
 */
const projectOfResourcePattern = (
  resource: string
): string | typeof ALL_PROJECTS | null => {
  if (resource === '*') return ALL_PROJECTS;
  if (!resource.startsWith('srn:')) return null;
  const parts = resource.split(':');
  if (parts.length < 4) return null;
  return parts[1] === '*' ? ALL_PROJECTS : parts[1];
};

// Parses the resource patterns of a single Allow statement into the project
// ids they scope to, or ALL_PROJECTS as soon as any pattern is unscoped.
const extractProjectIdsFromResourcePatterns = (
  resources: string[]
): string[] | typeof ALL_PROJECTS => {
  const projectIds: string[] = [];

  for (const resource of resources) {
    const projectId = projectOfResourcePattern(resource);
    if (projectId === ALL_PROJECTS) return ALL_PROJECTS;
    if (projectId !== null) projectIds.push(projectId);
  }

  return projectIds;
};

/**
 * Every `Allow` resource pattern that reaches past `projectPublicId`: one
 * naming another project, every project, a project glob or no project. An
 * `Allow` with no `resource` is `*`.
 */
export const findAllowResourcesOutsideProject = (args: {
  document: PolicyDocument;
  projectPublicId: string;
}): string[] => {
  return args.document.statement.flatMap((statement) => {
    if (statement.effect !== 'Allow') return [];
    return (statement.resource ?? ['*']).filter((resource) => {
      return projectOfResourcePattern(resource) !== args.projectPublicId;
    });
  });
};

/**
 * Extracts distinct project publicIds from the Allow statements of a set of
 * policies by parsing SRN resource patterns.
 *
 * Returns `undefined` when any statement grants access to all projects
 * (wildcard `*` or `srn:*:...`), meaning the caller should treat the result
 * as "all projects".
 *
 * Returns a (possibly empty) string[] of project publicIds when all patterns
 * are scoped to specific projects.
 */
export const extractProjectIdsFromPolicies = (
  policies: PolicyDocument[]
): string[] | undefined => {
  const projectIds = new Set<string>();

  for (const policy of policies) {
    for (const statement of policy.statement) {
      if (statement.effect !== 'Allow') continue;
      const resourceIds = extractProjectIdsFromResourcePatterns(
        statement.resource ?? ['*']
      );
      if (resourceIds === ALL_PROJECTS) return undefined;
      for (const projectId of resourceIds) projectIds.add(projectId);
    }
  }

  return Array.from(projectIds);
};

/**
 * The projects every set names, or `undefined` when no set narrows projects:
 * a request must satisfy each set, so it concerns only what they all name.
 */
export const extractProjectIdsFromPolicySets = (
  sets: PolicySets
): string[] | undefined => {
  if (sets.length === 0) return [];
  let named: string[] | undefined;
  for (const policies of sets) {
    const ids = extractProjectIdsFromPolicies(policies);
    if (ids === undefined) continue;
    named =
      named === undefined
        ? ids
        : named.filter((id) => {
            return ids.includes(id);
          });
  }
  return named;
};
