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

  if (args.authUser.apiKeyProjectId) {
    const project = await db.Project.findOne({
      where: { publicId: args.authUser.apiKeyProjectId },
    });
    return project ? [mapProject(project)] : [];
  }

  const userProjects = await db.UserProject.findAll({
    where: { userId: args.authUser.id },
    include: [{ model: db.Project }],
  });

  return userProjects.map((up) => {
    return mapProject(up.project as InstanceType<(typeof db)['Project']>);
  });
};

export const getProject = async (args: { id: string; authUser: AuthUser }) => {
  const project = await db.Project.findOne({ where: { publicId: args.id } });

  if (!project) {
    return 'not_found' as const;
  }

  if (args.authUser.role === 'admin') {
    return mapProject(project);
  }

  const membership = await db.UserProject.findOne({
    where: { userId: args.authUser.id, projectId: project.id },
  });

  if (!membership) {
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

const mapPolicy = (
  policy: InstanceType<(typeof db)['ProjectPolicy']>,
  projectPublicId: string
) => {
  return {
    id: policy.publicId,
    permissions: policy.permissions,
    notPermissions: policy.notPermissions,
    projectId: projectPublicId,
    createdAt: policy.createdAt,
    updatedAt: policy.updatedAt,
  };
};

export const listProjectPolicies = async (args: { projectId: string }) => {
  const project = await db.Project.findOne({
    where: { publicId: args.projectId },
  });
  if (!project) {
    return [];
  }

  const policies = await db.ProjectPolicy.findAll({
    where: { projectId: project.id },
  });

  return policies.map((policy) => {
    return mapPolicy(policy, project.publicId);
  });
};

export const createProjectPolicy = async (args: {
  projectId: string;
  permissions: string[];
  notPermissions?: string[];
}) => {
  const project = await db.Project.findOne({
    where: { publicId: args.projectId },
  });
  if (!project) {
    return null;
  }

  const policy = await db.ProjectPolicy.create({
    projectId: project.id,
    permissions: args.permissions,
    notPermissions: args.notPermissions || [],
  });

  return mapPolicy(policy, project.publicId);
};

export const addUserToProject = async (args: {
  projectId: string;
  userId: string;
  policyId: string;
}) => {
  const project = await db.Project.findOne({
    where: { publicId: args.projectId },
  });
  if (!project) {
    return null;
  }

  const user = await db.User.findOne({ where: { publicId: args.userId } });
  if (!user) {
    return null;
  }

  const policy = await db.ProjectPolicy.findOne({
    where: { publicId: args.policyId },
  });
  if (!policy) {
    return null;
  }

  // Check if membership already exists
  const existing = await db.UserProject.findOne({
    where: { userId: user.id, projectId: project.id },
  });

  if (existing) {
    // Update existing membership
    await existing.update({ policyId: policy.id });
    return true;
  }

  // Create new membership
  await db.UserProject.create({
    userId: user.id,
    projectId: project.id,
    policyId: policy.id,
  });

  return true;
};
