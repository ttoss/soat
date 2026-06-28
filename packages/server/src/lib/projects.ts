import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import type { AuthUser } from '../Context';
import { db } from '../db';
import { DomainError } from '../errors';

const log = createDebug('soat:projects');

const mapProject = (project: InstanceType<(typeof db)['Project']>) => {
  return {
    id: project.publicId,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
};

const mapMember = (args: {
  projectPublicId: string;
  user: InstanceType<(typeof db)['User']>;
}) => {
  return {
    projectId: args.projectPublicId,
    userId: args.user.publicId,
    username: args.user.username,
    role: args.user.role,
  };
};

/**
 * Project membership is modelled as a managed, project-scoped policy rather
 * than a dedicated join table — keeping policies the single source of truth
 * for project access. Each project has at most one membership policy, shared
 * by all its members and identified by this deterministic name.
 */
const memberPolicyName = (projectPublicId: string) => {
  return `member:${projectPublicId}`;
};

const getProjectOrThrow = async (id: string) => {
  const project = await db.Project.findOne({ where: { publicId: id } });

  if (!project) {
    throw new DomainError('RESOURCE_NOT_FOUND', `Project '${id}' not found.`);
  }

  return project;
};

const getUserOrThrow = async (id: string) => {
  const user = await db.User.findOne({ where: { publicId: id } });

  if (!user) {
    throw new DomainError('RESOURCE_NOT_FOUND', `User '${id}' not found.`);
  }

  return user;
};

/**
 * Finds the managed membership policy for a project, creating it on first use.
 * The policy grants full access to every resource scoped to the project,
 * mirroring the `soat:<project>:*:*` SRN that callers previously had to author
 * by hand.
 */
const findOrCreateMemberPolicy = async (projectPublicId: string) => {
  const name = memberPolicyName(projectPublicId);
  const existing = await db.Policy.findOne({ where: { name } });

  if (existing) {
    return existing;
  }

  log(
    'findOrCreateMemberPolicy: creating membership policy for %s',
    projectPublicId
  );

  return db.Policy.create({
    name,
    description: `Managed membership policy granting full access to project ${projectPublicId}.`,
    document: {
      statement: [
        {
          effect: 'Allow',
          action: ['*'],
          resource: [`soat:${projectPublicId}:*:*`],
        },
      ],
    },
  });
};

export const listProjects = async (args: { authUser: AuthUser }) => {
  // Admin fast-path: skip when the request uses a project-scoped API key or a
  // project-scoped OAuth token so the restriction is enforced even for admins.
  if (
    args.authUser.role === 'admin' &&
    !args.authUser.apiKeyProjectPublicId &&
    !args.authUser.oauthProjectPublicId
  ) {
    const projects = await db.Project.findAll();
    return projects.map(mapProject);
  }

  const projectIds = await args.authUser.resolveProjectIds({
    action: 'projects:ListProjects',
  });

  if (projectIds === null) return [];

  if (projectIds === undefined) {
    const projects = await db.Project.findAll();
    return projects.map(mapProject);
  }

  if (projectIds.length === 0) return [];

  const projects = await db.Project.findAll({ where: { id: projectIds } });
  return projects.map(mapProject);
};

export const getProject = async (args: { id: string; authUser: AuthUser }) => {
  const project = await db.Project.findOne({ where: { publicId: args.id } });

  if (!project) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Project '${args.id}' not found.`
    );
  }

  if (args.authUser.role === 'admin' && !args.authUser.oauthProjectPublicId) {
    return mapProject(project);
  }

  const allowed = await args.authUser.isAllowed({
    projectPublicId: args.id,
    action: 'projects:GetProject',
    // Probe with the project's SRN (consistent with listProjects /
    // resolveProjectIds) so project-scoped policies — including the managed
    // membership policy — grant access, not just unscoped `*` policies.
    resource: `soat:${args.id}:*:*`,
  });

  if (!allowed) {
    throw new DomainError(
      'FORBIDDEN',
      `You do not have permission to access project '${args.id}'.`
    );
  }

  return mapProject(project);
};

export const createProject = async (args: { name: string }) => {
  const project = await db.Project.create({ name: args.name });
  return mapProject(project);
};

export const updateProject = async (args: { id: string; name: string }) => {
  log('updateProject: id=%s name=%s', args.id, args.name);

  const project = await getProjectOrThrow(args.id);

  await project.update({ name: args.name });

  return mapProject(project);
};

export const deleteProject = async (args: { id: string }): Promise<void> => {
  const project = await db.Project.findOne({ where: { publicId: args.id } });

  if (!project) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Project '${args.id}' not found.`
    );
  }

  await project.destroy();
};

export const listProjectMembers = async (args: { projectId: string }) => {
  log('listProjectMembers: projectId=%s', args.projectId);

  await getProjectOrThrow(args.projectId);

  const policy = await db.Policy.findOne({
    where: { name: memberPolicyName(args.projectId) },
  });

  if (!policy) {
    return [];
  }

  const members = await db.User.findAll({
    where: { policyIds: { [Op.contains]: [policy.id as number] } },
  });

  return members.map((user: InstanceType<(typeof db)['User']>) => {
    return mapMember({ projectPublicId: args.projectId, user });
  });
};

export const addProjectMember = async (args: {
  projectId: string;
  userId: string;
}) => {
  log('addProjectMember: projectId=%s userId=%s', args.projectId, args.userId);

  await getProjectOrThrow(args.projectId);
  const user = await getUserOrThrow(args.userId);

  const policy = await findOrCreateMemberPolicy(args.projectId);
  const policyId = policy.id as number;
  const policyIds = (user.policyIds as number[] | undefined) ?? [];

  if (!policyIds.includes(policyId)) {
    await user.update({ policyIds: [...policyIds, policyId] });
    log(
      'addProjectMember: attached policy id=%s to user=%s',
      policyId,
      args.userId
    );
  }

  return mapMember({ projectPublicId: args.projectId, user });
};

export const removeProjectMember = async (args: {
  projectId: string;
  userId: string;
}): Promise<void> => {
  log(
    'removeProjectMember: projectId=%s userId=%s',
    args.projectId,
    args.userId
  );

  await getProjectOrThrow(args.projectId);
  const user = await getUserOrThrow(args.userId);

  const policy = await db.Policy.findOne({
    where: { name: memberPolicyName(args.projectId) },
  });
  const policyId = policy?.id as number | undefined;
  const policyIds = (user.policyIds as number[] | undefined) ?? [];

  if (policyId === undefined || !policyIds.includes(policyId)) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `User '${args.userId}' is not a member of project '${args.projectId}'.`
    );
  }

  await user.update({
    policyIds: policyIds.filter((id) => {
      return id !== policyId;
    }),
  });
};
