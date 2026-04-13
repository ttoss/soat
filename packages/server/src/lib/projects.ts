import type { AuthUser } from '../Context';
import { db } from '../db';
import type { PolicyDocument } from './iam';
import { validatePolicyDocument } from './iam';

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

  if (args.authUser.projectKeyProjectId) {
    const project = await db.Project.findOne({
      where: { publicId: args.authUser.projectKeyProjectId },
    });
    return project ? [mapProject(project)] : [];
  }

  const userProjects = await db.UserProject.findAll({
    where: { userId: args.authUser.id },
    include: [{ model: db.Project }],
  });

  return userProjects.map((up: InstanceType<(typeof db)['UserProject']>) => {
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
  const doc = policy.document as PolicyDocument | undefined;
  const permissions =
    doc?.statement
      ?.filter((s) => {
        return s.effect === 'Allow';
      })
      .flatMap((s) => {
        return s.action;
      }) ?? [];
  const notPermissions =
    doc?.statement
      ?.filter((s) => {
        return s.effect === 'Deny';
      })
      .flatMap((s) => {
        return s.action;
      }) ?? [];
  return {
    id: policy.publicId,
    name: policy.name,
    description: policy.description,
    permissions,
    notPermissions,
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

  return policies.map((policy: InstanceType<(typeof db)['ProjectPolicy']>) => {
    return mapPolicy(policy, project.publicId);
  });
};

export const createProjectPolicy = async (args: {
  projectId: string;
  name?: string;
  description?: string;
  document: PolicyDocument;
}): Promise<
  | ReturnType<typeof mapPolicy>
  | 'not_found'
  | { invalid: true; errors: string[] }
> => {
  const validation = validatePolicyDocument(args.document);
  if (!validation.valid) {
    return { invalid: true, errors: validation.errors };
  }

  const project = await db.Project.findOne({
    where: { publicId: args.projectId },
  });
  if (!project) {
    return 'not_found';
  }

  const policy = await db.ProjectPolicy.create({
    projectId: project.id,
    name: args.name ?? null,
    description: args.description ?? null,
    document: args.document as object,
  });

  return mapPolicy(policy, project.publicId);
};

export const updateProjectPolicy = async (args: {
  projectId: string;
  policyId: string;
  name?: string;
  description?: string;
  document: PolicyDocument;
}): Promise<
  | ReturnType<typeof mapPolicy>
  | 'not_found'
  | { invalid: true; errors: string[] }
> => {
  const validation = validatePolicyDocument(args.document);
  if (!validation.valid) {
    return { invalid: true, errors: validation.errors };
  }

  const project = await db.Project.findOne({
    where: { publicId: args.projectId },
  });
  if (!project) {
    return 'not_found';
  }

  const policy = await db.ProjectPolicy.findOne({
    where: { publicId: args.policyId, projectId: project.id },
  });
  if (!policy) {
    return 'not_found';
  }

  await policy.update({
    name: args.name ?? policy.name,
    description: args.description ?? policy.description,
    document: args.document as object,
  });

  return mapPolicy(policy, project.publicId);
};

export const deleteProjectPolicy = async (args: {
  projectId: string;
  policyId: string;
}): Promise<'not_found' | true> => {
  const project = await db.Project.findOne({
    where: { publicId: args.projectId },
  });
  if (!project) {
    return 'not_found';
  }

  const policy = await db.ProjectPolicy.findOne({
    where: { publicId: args.policyId, projectId: project.id },
  });
  if (!policy) {
    return 'not_found';
  }

  await policy.destroy();
  return true;
};

export const getProjectPolicy = async (args: {
  projectId: string;
  policyId: string;
}) => {
  const project = await db.Project.findOne({
    where: { publicId: args.projectId },
  });
  if (!project) {
    return null;
  }

  const policy = await db.ProjectPolicy.findOne({
    where: { publicId: args.policyId, projectId: project.id },
  });
  if (!policy) {
    return null;
  }

  return mapPolicy(policy, project.publicId);
};

export const addUserToProject = async (args: {
  projectId: string;
  userId: string;
  policyIds?: string[];
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

  let resolvedPolicyIds: number[] = [];
  if (args.policyIds && args.policyIds.length > 0) {
    const policies = await db.ProjectPolicy.findAll({
      where: { publicId: args.policyIds, projectId: project.id },
    });
    if (policies.length !== args.policyIds.length) {
      return null;
    }
    resolvedPolicyIds = policies.map(
      (p: InstanceType<(typeof db)['ProjectPolicy']>) => {
        return p.id as number;
      }
    );
  }

  // Check if membership already exists
  const existing = await db.UserProject.findOne({
    where: { userId: user.id, projectId: project.id },
  });

  if (existing) {
    await existing.update({ policyIds: resolvedPolicyIds });
    return true;
  }

  await db.UserProject.create({
    userId: user.id,
    projectId: project.id,
    policyIds: resolvedPolicyIds,
  });

  return true;
};

export const updateUserProjectPolicies = async (args: {
  projectId: string;
  userId: string;
  policyIds: string[];
}) => {
  const project = await db.Project.findOne({
    where: { publicId: args.projectId },
  });
  if (!project) {
    return 'not_found' as const;
  }

  const user = await db.User.findOne({ where: { publicId: args.userId } });
  if (!user) {
    return 'not_found' as const;
  }

  const membership = await db.UserProject.findOne({
    where: { userId: user.id, projectId: project.id },
  });
  if (!membership) {
    return 'not_found' as const;
  }

  const policies = await db.ProjectPolicy.findAll({
    where: { publicId: args.policyIds, projectId: project.id },
  });
  if (policies.length !== args.policyIds.length) {
    return 'not_found' as const;
  }

  await membership.update({
    policyIds: policies.map((p: InstanceType<(typeof db)['ProjectPolicy']>) => {
      return p.id as number;
    }),
  });
  return true;
};

export const getUserProjectPolicies = async (args: {
  projectId: string;
  userId: string;
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

  const membership = await db.UserProject.findOne({
    where: { userId: user.id, projectId: project.id },
  });
  if (!membership) {
    return null;
  }

  if (!membership.policyIds || membership.policyIds.length === 0) {
    return [];
  }

  const policies = await db.ProjectPolicy.findAll({
    where: { id: membership.policyIds, projectId: project.id },
  });

  return policies.map((p: InstanceType<(typeof db)['ProjectPolicy']>) => {
    return mapPolicy(p, project.publicId);
  });
};
