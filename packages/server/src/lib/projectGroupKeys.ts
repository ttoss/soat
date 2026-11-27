import type { AuthUser } from '../Context';
import { db } from '../db';
import { DomainError } from '../errors';
import { callerDenied } from './authorizationDenial';
import { buildProjectGroupSrn } from './projectGroupActions';

/** A project group action on one key of the project group, or on its keys as a whole. */
const assertProjectGroupKeyAction = async (args: {
  authUser: AuthUser;
  projectGroupPublicId: string;
  action: string;
  keyPublicId?: string;
}): Promise<void> => {
  const resource = buildProjectGroupSrn({
    projectGroupPublicId: args.projectGroupPublicId,
    resourceType: 'api_key',
    resourceId: args.keyPublicId,
  });
  const allowed = await args.authUser.isAllowedOnProjectGroup({
    projectGroupPublicId: args.projectGroupPublicId,
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
 * The project group a key create names in `project_group_id`, once the caller may create a
 * key of it; both ids `null` when it names none. A project group key has no project.
 */
export const resolveCreatedKeyProjectGroup = async (args: {
  authUser: AuthUser;
  projectGroupId: unknown;
  projectId: unknown;
}): Promise<
  { id: number; publicId: string } | { id: null; publicId: null }
> => {
  if (args.projectGroupId === undefined || args.projectGroupId === null)
    return { id: null, publicId: null };
  if (args.projectId !== undefined && args.projectId !== null) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'project_id and project_group_id are mutually exclusive.'
    );
  }
  const group =
    typeof args.projectGroupId === 'string'
      ? await db.ProjectGroup.findOne({
          where: { publicId: args.projectGroupId },
        })
      : null;
  if (!group)
    throw new DomainError('VALIDATION_FAILED', 'Invalid project group');
  await assertProjectGroupKeyAction({
    authUser: args.authUser,
    projectGroupPublicId: group.publicId as string,
    action: 'project-groups:CreateApiKey',
  });
  return { id: group.id as number, publicId: group.publicId as string };
};

/** Revoking a project group key is a project group action on that key. */
export const assertProjectGroupKeyRevocable = async (args: {
  authUser: AuthUser;
  key: { id: string; project_group_id: string | null };
}): Promise<void> => {
  if (args.key.project_group_id === null) return;
  await assertProjectGroupKeyAction({
    authUser: args.authUser,
    projectGroupPublicId: args.key.project_group_id,
    action: 'project-groups:RevokeApiKey',
    keyPublicId: args.key.id,
  });
};

/**
 * A project group key manages only keys of its project group or of a project in it, so it
 * never writes a key reaching past its project group.
 */
export const assertCredentialProjectGroupScope = async (args: {
  authUser: AuthUser;
  key: { project_id: string | null; project_group_id: string | null };
  action: string;
}): Promise<void> => {
  const scoped = args.authUser.apiKeyProjectGroupPublicId;
  if (scoped === undefined || args.key.project_group_id === scoped) return;
  const inProjectGroup =
    args.key.project_id !== null &&
    (await db.Project.count({
      where: {
        publicId: args.key.project_id,
        projectGroupId: args.authUser.apiKeyProjectGroupId,
      },
    })) > 0;
  if (inProjectGroup) return;
  throw callerDenied({
    authUser: args.authUser,
    action: args.action,
    resource: null,
  });
};
