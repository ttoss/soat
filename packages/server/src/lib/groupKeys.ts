import type { AuthUser } from '../Context';
import { db } from '../db';
import { DomainError } from '../errors';
import { callerDenied } from './authorizationDenial';
import { buildGroupSrn } from './groupActions';

/** A group action on one key of the group, or on its keys as a whole. */
const assertGroupKeyAction = async (args: {
  authUser: AuthUser;
  groupPublicId: string;
  action: string;
  keyPublicId?: string;
}): Promise<void> => {
  const resource = buildGroupSrn({
    groupPublicId: args.groupPublicId,
    resourceType: 'api_key',
    resourceId: args.keyPublicId,
  });
  const allowed = await args.authUser.isAllowedOnGroup({
    groupPublicId: args.groupPublicId,
    action: args.action,
    resource,
  });
  if (!allowed) {
    throw callerDenied({
      authUser: args.authUser,
      action: args.action,
      resource,
    });
  }
};

/**
 * The group a key create names in `group_id`, once the caller may create a
 * key of it; `null` when it names none. A group key has no project.
 */
export const resolveCreatedKeyGroup = async (args: {
  authUser: AuthUser;
  groupId: unknown;
  projectId: unknown;
}): Promise<{ id: number; publicId: string } | null> => {
  if (args.groupId === undefined || args.groupId === null) return null;
  if (args.projectId !== undefined && args.projectId !== null) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'project_id and group_id are mutually exclusive.'
    );
  }
  const group =
    typeof args.groupId === 'string'
      ? await db.Group.findOne({ where: { publicId: args.groupId } })
      : null;
  if (!group) throw new DomainError('VALIDATION_FAILED', 'Invalid group');
  await assertGroupKeyAction({
    authUser: args.authUser,
    groupPublicId: group.publicId as string,
    action: 'groups:CreateApiKey',
  });
  return { id: group.id as number, publicId: group.publicId as string };
};

/** Revoking a group key is a group action on that key. */
export const assertGroupKeyRevocable = async (args: {
  authUser: AuthUser;
  key: { id: string; group_id: string | null };
}): Promise<void> => {
  if (args.key.group_id === null) return;
  await assertGroupKeyAction({
    authUser: args.authUser,
    groupPublicId: args.key.group_id,
    action: 'groups:RevokeApiKey',
    keyPublicId: args.key.id,
  });
};

/**
 * A group key manages only keys of its group or of a project in it, so it
 * never writes a key reaching past its group.
 */
export const assertCredentialGroupScope = async (args: {
  authUser: AuthUser;
  key: { project_id: string | null; group_id: string | null };
  action: string;
}): Promise<void> => {
  const scoped = args.authUser.apiKeyGroupPublicId;
  if (scoped === undefined || args.key.group_id === scoped) return;
  const inGroup =
    args.key.project_id !== null &&
    (await db.Project.count({
      where: {
        publicId: args.key.project_id,
        groupId: args.authUser.apiKeyGroupId,
      },
    })) > 0;
  if (inGroup) return;
  throw callerDenied({
    authUser: args.authUser,
    action: args.action,
    resource: null,
  });
};
