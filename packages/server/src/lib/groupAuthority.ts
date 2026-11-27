import { db } from '../db';
import { resolveAttachedPolicies } from './attachedPolicies';
import { groupSrnPattern } from './groupActions';
import type { PolicyDocument } from './iam';

/** Where a check lands: a project, or a group's own resources. */
export type CheckScope = { project: string } | { group: string };

/** The group a check's scope falls in, or null when it is in none. */
const groupOfScope = async (
  scope: CheckScope
): Promise<{ id: number; publicId: string } | null> => {
  if ('group' in scope) {
    const group = await db.Group.findOne({
      where: { publicId: scope.group },
      attributes: ['id', 'publicId'],
    });
    return group
      ? { id: group.id as number, publicId: group.publicId as string }
      : null;
  }
  const project = await db.Project.findOne({
    where: { publicId: scope.project },
    attributes: ['groupId'],
    include: [{ model: db.Group, as: 'group', attributes: ['publicId'] }],
  });
  if (!project?.groupId || !project.group) return null;
  return { id: project.groupId, publicId: project.group.publicId as string };
};

/**
 * The group's attached policies, fixed and the owner's, as one document every
 * check in the group must satisfy; `null` when the scope is in no group or the
 * group attaches none. A policy that no longer resolves allows nothing.
 */
export const loadGroupCap = async (args: {
  scope: CheckScope;
}): Promise<{ group: string; document: PolicyDocument } | null> => {
  const found = await groupOfScope(args.scope);
  if (!found) return null;
  const group = await db.Group.findByPk(found.id, {
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
  return document ? { group: found.publicId, document } : null;
};

/**
 * What the owner of a group holds on it: every group action on the group's
 * own resources, never on its projects. Null for a user owning none.
 */
export const loadOwnedGroupsGrant = async (args: {
  userPublicId: string;
}): Promise<PolicyDocument | null> => {
  const groups = await db.Group.findAll({
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
        action: ['groups:*'],
        resource: groups.map((group) => {
          return groupSrnPattern(group.publicId as string);
        }),
      },
    ],
  };
};

/**
 * Where a group key acts: its group's own resources and the projects in the
 * group, read live so a project joining or leaving moves it.
 */
export const loadGroupConfinement = async (args: {
  groupId: number;
}): Promise<PolicyDocument> => {
  const group = await db.Group.findByPk(args.groupId, {
    attributes: ['publicId'],
  });
  if (!group) {
    return { statement: [{ effect: 'Deny', action: ['*'], resource: ['*'] }] };
  }
  const projects = await db.Project.findAll({
    where: { groupId: args.groupId },
    attributes: ['publicId'],
  });
  return {
    statement: [
      {
        effect: 'Allow',
        action: ['*'],
        resource: [
          groupSrnPattern(group.publicId as string),
          ...projects.map((project) => {
            return `srn:${project.publicId as string}:*:*`;
          }),
        ],
      },
    ],
  };
};
