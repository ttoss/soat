import type { AuthUser } from '../Context';
import { db } from '../db';

const mapProject = (project: InstanceType<(typeof db)['Project']>) => {
  return {
    id: project.publicId,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
};

export const listProjects = async (args: { authUser: AuthUser }) => {
  if (args.authUser.role === 'admin') {
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
    return 'not_found' as const;
  }

  if (args.authUser.role === 'admin') {
    return mapProject(project);
  }

  const allowed = await args.authUser.isAllowed({
    projectPublicId: args.id,
    action: 'projects:GetProject',
  });

  if (!allowed) {
    return 'forbidden' as const;
  }

  return mapProject(project);
};

export const createProject = async (args: { name: string }) => {
  const project = await db.Project.create({ name: args.name });
  return mapProject(project);
};

export const deleteProject = async (args: { id: string }) => {
  const project = await db.Project.findOne({ where: { publicId: args.id } });

  if (!project) {
    return null;
  }

  await project.destroy();
  return true;
};
