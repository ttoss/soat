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
 * The document a policy grants: a project policy's `Allow` with no `resource`
 * covers every resource of its project, never wider. Every reader evaluating a
 * stored policy goes through it; the stored document stays as written.
 */
export const scopePolicyDocument = (args: {
  document: PolicyDocument;
  projectPublicId: string | null;
}): PolicyDocument => {
  const { projectPublicId } = args;
  if (projectPublicId === null) return args.document;
  return {
    ...args.document,
    statement: args.document.statement.map((statement) => {
      if (statement.effect !== 'Allow' || statement.resource !== undefined) {
        return statement;
      }
      return { ...statement, resource: [`srn:${projectPublicId}:*:*`] };
    }),
  };
};

const explicitAllowResources = (document: PolicyDocument): string[] => {
  return document.statement.flatMap((statement) => {
    return statement.effect === 'Allow' ? (statement.resource ?? []) : [];
  });
};

/**
 * Every `Allow` resource pattern that reaches past `projectPublicId`: one
 * naming another project, every project, a project glob or no project.
 */
export const findAllowResourcesOutsideProject = (args: {
  document: PolicyDocument;
  projectPublicId: string;
}): string[] => {
  return explicitAllowResources(args.document).filter((resource) => {
    return projectSegment(resource) !== args.projectPublicId;
  });
};

/**
 * Every `Allow` resource pattern no project policy may hold, whatever its
 * project: `*`, every project, a project glob or no project.
 */
export const findAllowResourcesOutsideEveryProject = (
  document: PolicyDocument
): string[] => {
  return explicitAllowResources(document).filter((resource) => {
    return typeof projectOfResourcePattern(resource) !== 'string';
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

/** Whether some `Allow` of the policy names a resource `reaches` accepts. */
const policyReaches = (args: {
  policy: PolicyDocument;
  reaches: (resource: string) => boolean;
}): boolean => {
  return args.policy.statement.some((statement) => {
    if (statement.effect !== 'Allow') return false;
    return (statement.resource ?? ['*']).some(args.reaches);
  });
};

/**
 * Whether every set has a policy `reaches` accepts: a request must satisfy
 * each set, so it concerns only what they all reach. No set concerns nothing.
 */
const policySetsReach = (args: {
  sets: PolicySets;
  reaches: (resource: string) => boolean;
}): boolean => {
  if (args.sets.length === 0) return false;
  return args.sets.every((policies) => {
    return policies.some((policy) => {
      return policyReaches({ policy, reaches: args.reaches });
    });
  });
};

/**
 * Whether every set has an `Allow` whose project segment matches the project.
 */
export const policySetsConcernProject = (args: {
  sets: PolicySets;
  projectPublicId: string;
}): boolean => {
  return policySetsReach({
    sets: args.sets,
    reaches: (resource) => {
      const segment = projectSegment(resource);
      return (
        segment !== null &&
        matchesPattern({ pattern: segment, value: args.projectPublicId })
      );
    },
  });
};

/**
 * Whether every set has an `Allow` naming the project group: `*`, or an SRN
 * whose first two segments match `project-group` and its id.
 */
export const policySetsConcernProjectGroup = (args: {
  sets: PolicySets;
  projectGroupPublicId: string;
}): boolean => {
  return policySetsReach({
    sets: args.sets,
    reaches: (resource) => {
      if (resource === '*') return true;
      const parts = resource.split(':');
      if (parts[0] !== 'srn' || parts.length < 4) return false;
      return (
        matchesPattern({ pattern: parts[1], value: 'project-group' }) &&
        matchesPattern({ pattern: parts[2], value: args.projectGroupPublicId })
      );
    },
  });
};
