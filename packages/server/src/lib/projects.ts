import type { AuthUser } from '../Context';
import { db } from '../db';
import { DomainError } from '../errors';

const mapProject = (project: InstanceType<(typeof db)['Project']>) => {
  return {
    id: project.publicId,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
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
