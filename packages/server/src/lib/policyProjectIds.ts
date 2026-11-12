import type { PolicyDocument, PolicySets } from './iam';
import { matchesPattern } from './iam';

// Sentinel distinguishing "this statement grants access to all projects" from
// a (possibly empty) list of specific project ids, without reusing `undefined`
// (which already means something different one level up).
const ALL_PROJECTS = Symbol('ALL_PROJECTS');

/**
 * The project segment one resource pattern names, `*` for the pattern `*`, or
 * `null` for a pattern that is not a full SRN. The segment may be a glob.
 */
const projectSegment = (resource: string): string | null => {
  if (resource === '*') return '*';
  if (!resource.startsWith('srn:')) return null;
  const parts = resource.split(':');
  if (parts.length < 4) return null;
  return parts[1];
};

/** ALL_PROJECTS for a glob segment, which only `isAllowed` can resolve. */
const projectOfResourcePattern = (
  resource: string
): string | typeof ALL_PROJECTS | null => {
  const segment = projectSegment(resource);
  if (segment === null) return null;
  return /[*?]/.test(segment) ? ALL_PROJECTS : segment;
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
      return projectSegment(resource) !== args.projectPublicId;
    });
  });
};

/**
 * Extracts distinct project publicIds from the Allow statements of a set of
 * policies by parsing SRN resource patterns.
 *
 * Returns `undefined` when any statement grants access to all projects
 * (wildcard `*`, `srn:*:...` or a glob such as `srn:proj_a*:...`), meaning the caller should treat the result
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

const policyReachesProject = (args: {
  policy: PolicyDocument;
  projectPublicId: string;
}): boolean => {
  return args.policy.statement.some((statement) => {
    if (statement.effect !== 'Allow') return false;
    return (statement.resource ?? ['*']).some((resource) => {
      const segment = projectSegment(resource);
      return (
        segment !== null &&
        matchesPattern({ pattern: segment, value: args.projectPublicId })
      );
    });
  });
};

/**
 * Whether every set has an `Allow` whose project segment matches the project:
 * a request must satisfy each set, so it concerns only what they all reach.
 * No set concerns no project.
 */
export const policySetsConcernProject = (args: {
  sets: PolicySets;
  projectPublicId: string;
}): boolean => {
  if (args.sets.length === 0) return false;
  return args.sets.every((policies) => {
    return policies.some((policy) => {
      return policyReachesProject({
        policy,
        projectPublicId: args.projectPublicId,
      });
    });
  });
};
