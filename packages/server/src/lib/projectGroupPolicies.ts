import { db } from '../db';
import type { PolicyDocument, Statement } from './iam';
import { validatePolicyActions } from './iam';
import { validatePolicyDocument } from './policyDocumentValidation';
import { scopePolicyDocument } from './policyProjectIds';
import { projectGroupSrnPattern } from './projectGroupActions';

/** A project group as a policy of it reads it: its id and its projects, live. */
export type PolicyProjectGroup = {
  publicId: string;
  projectPublicIds: string[];
};

const PROJECT_GROUP_ACTION_PREFIX = 'project-groups:';

/**
 * Whether `resource` is inside the project group: its own resources, or a
 * project in it, named exactly (no glob in the project or project group).
 */
const isInsideProjectGroup = (args: {
  resource: string;
  projectGroup: PolicyProjectGroup;
}): boolean => {
  const ownPrefix = `srn:project-group:${args.projectGroup.publicId}:`;
  if (args.resource.startsWith(ownPrefix)) return true;
  const parts = /^srn:([^:]+):[^:]+:[^:]+$/.exec(args.resource);
  return (
    parts !== null && args.projectGroup.projectPublicIds.includes(parts[1])
  );
};

/** Every resource an `Allow` without `resource` grants `action` on. */
const defaultResources = (args: {
  action: string;
  projectGroup: PolicyProjectGroup;
}): string[] => {
  const { action, projectGroup } = args;
  const head = action.split(/[*?]/)[0];
  const onProjectGroup =
    action.startsWith(PROJECT_GROUP_ACTION_PREFIX) ||
    (head !== action && PROJECT_GROUP_ACTION_PREFIX.startsWith(head));
  const onProjects = !action.startsWith(PROJECT_GROUP_ACTION_PREFIX);
  return [
    ...(onProjectGroup ? [projectGroupSrnPattern(projectGroup.publicId)] : []),
    ...(onProjects
      ? projectGroup.projectPublicIds.map((project) => {
          return `srn:${project}:*:*`;
        })
      : []),
  ];
};

/**
 * The document a project group policy grants: each `Allow` reaches only the
 * project group's own resources and the projects in it now. One without
 * `resource` grants a project group action on the project group and any other
 * action on its projects. A `Deny` stays as written.
 */
export const scopeProjectGroupPolicyDocument = (args: {
  document: PolicyDocument;
  projectGroup: PolicyProjectGroup;
}): PolicyDocument => {
  const { projectGroup } = args;
  const statement = args.document.statement.flatMap((stmt): Statement[] => {
    if (stmt.effect !== 'Allow') return [stmt];
    if (stmt.resource !== undefined) {
      const resource = stmt.resource.filter((pattern) => {
        return isInsideProjectGroup({ resource: pattern, projectGroup });
      });
      return resource.length > 0 ? [{ ...stmt, resource }] : [];
    }
    return stmt.action.flatMap((action) => {
      const resource = defaultResources({ action, projectGroup });
      return resource.length > 0
        ? [{ ...stmt, action: [action], resource }]
        : [];
    });
  });
  return { ...args.document, statement };
};

/**
 * Every refusal of a project group policy's document: an `Allow` resource
 * outside the project group is refused.
 */
export const validateProjectGroupPolicyDocument = (args: {
  document: unknown;
  projectGroup: PolicyProjectGroup;
}): string[] => {
  const allowResourceForm = `srn:project-group:${args.projectGroup.publicId}:<type>/<id>, srn:<project_id>:<type>:<id> for a project in the project group, or omit resource for every resource of the project group`;
  const structural = validatePolicyDocument(args.document, {
    allowResourceForm,
  });
  if (!structural.valid) return structural.errors;
  const document = args.document as PolicyDocument;
  const outside = document.statement.flatMap((stmt) => {
    if (stmt.effect !== 'Allow') return [];
    return (stmt.resource ?? []).filter((resource) => {
      return !isInsideProjectGroup({
        resource,
        projectGroup: args.projectGroup,
      });
    });
  });
  return [
    ...validatePolicyActions(document).errors,
    ...outside.map((resource) => {
      return `Allow resource '${resource}' is outside the policy's project group; name ${allowResourceForm}.`;
    }),
  ];
};

/** Each project group by database id, with the projects in it now. */
export const loadPolicyProjectGroups = async (
  projectGroupIds: number[]
): Promise<Map<number, PolicyProjectGroup>> => {
  const ids = [...new Set(projectGroupIds)];
  if (ids.length === 0) return new Map();
  const [groups, projects] = await Promise.all([
    db.ProjectGroup.findAll({
      where: { id: ids },
      attributes: ['id', 'publicId'],
    }),
    db.Project.findAll({
      where: { projectGroupId: ids },
      attributes: ['publicId', 'projectGroupId'],
      order: [['id', 'ASC']],
    }),
  ]);
  return new Map(
    groups.map((group) => {
      return [
        group.id as number,
        {
          publicId: group.publicId as string,
          projectPublicIds: projects
            .filter((project) => {
              return project.projectGroupId === group.id;
            })
            .map((project) => {
              return project.publicId as string;
            }),
        },
      ];
    })
  );
};

/** A stored policy as its owner reads it: project, project group, or neither. */
type StoredPolicy = {
  document: object;
  projectGroupId: number | null;
  project?: { publicId: string } | null;
};

/**
 * What each stored policy grants, in order: a project policy within its
 * project, a project group policy within its project group, a global one as
 * written. Every reader evaluating a stored policy goes through it.
 */
export const grantedPolicyDocuments = async (
  rows: StoredPolicy[]
): Promise<PolicyDocument[]> => {
  const groups = await loadPolicyProjectGroups(
    rows.flatMap((row) => {
      return row.projectGroupId === null ? [] : [row.projectGroupId];
    })
  );
  return rows.map((row) => {
    const document = row.document as PolicyDocument;
    if (row.projectGroupId === null) {
      return scopePolicyDocument({
        document,
        projectPublicId: row.project?.publicId ?? null,
      });
    }
    const projectGroup = groups.get(row.projectGroupId);
    return projectGroup
      ? scopeProjectGroupPolicyDocument({ document, projectGroup })
      : { statement: [] };
  });
};
