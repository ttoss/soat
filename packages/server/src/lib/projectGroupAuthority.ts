import { db } from '../db';
import { resolveAttachedPolicies } from './attachedPolicies';
import type { PolicyDocument } from './iam';
import { listProjectGroupActionPatterns } from './iamRegistrations';
import { projectGroupSrnPattern } from './projectGroupActions';

/** Where a check lands: a project, or a project group's own resources. */
export type CheckScope = { project: string } | { projectGroup: string };

/** The project group a check's scope falls in, or null when it is in none. */
const projectGroupOfScope = async (
  scope: CheckScope
): Promise<{ id: number; publicId: string } | null> => {
  if ('projectGroup' in scope) {
    const group = await db.ProjectGroup.findOne({
      where: { publicId: scope.projectGroup },
      attributes: ['id', 'publicId'],
    });
    return group
      ? { id: group.id as number, publicId: group.publicId as string }
      : null;
  }
  const project = await db.Project.findOne({
    where: { publicId: scope.project },
    attributes: ['projectGroupId'],
    include: [
      { model: db.ProjectGroup, as: 'projectGroup', attributes: ['publicId'] },
    ],
  });
  if (!project?.projectGroupId || !project.projectGroup) return null;
  return {
    id: project.projectGroupId,
    publicId: project.projectGroup.publicId as string,
  };
};

/**
 * The project group's attached policies, fixed and the owner's, as one document every
 * check in the project group must satisfy; `null` when the scope is in no project group or the
 * project group attaches none. A policy that no longer resolves allows nothing.
 */
export const loadProjectGroupCap = async (args: {
  scope: CheckScope;
}): Promise<{ projectGroup: string; document: PolicyDocument } | null> => {
  const found = await projectGroupOfScope(args.scope);
  if (!found) return null;
  const group = await db.ProjectGroup.findByPk(found.id, {
    attributes: ['policyIds', 'fixedPolicyIds'],
  });
  const policyIds = [
    ...(group?.fixedPolicyIds ?? []),
    ...(group?.policyIds ?? []),
  ];
  const document = await resolveAttachedPolicies({
    policyIds,
    actorId: null,
  });
  return document ? { projectGroup: found.publicId, document } : null;
};

/**
 * What the owner of a project group holds on it: every project group action, built-in or
 * registered, on the project group's own resources, never on its projects. Null for a user owning none.
 */
export const loadOwnedProjectGroupsGrant = async (args: {
  userPublicId: string;
}): Promise<PolicyDocument | null> => {
  const groups = await db.ProjectGroup.findAll({
    attributes: ['publicId'],
    include: [
      {
        model: db.User,
        as: 'owner',
        attributes: [],
        where: { publicId: args.userPublicId },
      },
    ],
  });
  if (groups.length === 0) return null;
  return {
    statement: [
      {
        effect: 'Allow',
        action: listProjectGroupActionPatterns(),
        resource: groups.map((group) => {
          return projectGroupSrnPattern(group.publicId as string);
        }),
      },
    ],
  };
};

/**
 * Where a project group key acts: its project group's own resources and the projects in the
 * project group, read live so a project joining or leaving moves it.
 */
export const loadProjectGroupConfinement = async (args: {
  projectGroupId: number;
}): Promise<PolicyDocument> => {
  const group = await db.ProjectGroup.findByPk(args.projectGroupId, {
    attributes: ['publicId'],
  });
  if (!group) {
    return { statement: [{ effect: 'Deny', action: ['*'], resource: ['*'] }] };
  }
  const projects = await db.Project.findAll({
    where: { projectGroupId: args.projectGroupId },
    attributes: ['publicId'],
  });
  return {
    statement: [
      {
        effect: 'Allow',
        action: ['*'],
        resource: [
          projectGroupSrnPattern(group.publicId as string),
          ...projects.map((project) => {
            return `srn:${project.publicId as string}:*:*`;
          }),
        ],
      },
    ],
  };
};
