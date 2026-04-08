import type { DB } from '../db';

export type Policy = {
  permissions: string[];
  notPermissions: string[];
};

const matchesPattern = (pattern: string, action: string): boolean => {
  if (pattern === '*') return true;
  if (pattern === action) return true;

  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -1); // e.g. "files:"
    return action.startsWith(prefix);
  }

  return false;
};

export const policyAllows = (policy: Policy, action: string): boolean => {
  for (const pattern of policy.notPermissions) {
    if (matchesPattern(pattern, action)) return false;
  }

  for (const pattern of policy.permissions) {
    if (matchesPattern(pattern, action)) return true;
  }

  return false;
};

export const createApiKeyIsAllowed = (args: {
  projectPublicId: string;
  policy: Policy;
}) => {
  return async (
    reqProjectPublicId: string,
    action: string
  ): Promise<boolean> => {
    if (reqProjectPublicId !== args.projectPublicId) return false;
    return policyAllows(args.policy, action);
  };
};

export const createJwtIsAllowed = (args: {
  role: 'admin' | 'user';
  userId: number;
  db: DB;
}) => {
  return async (projectPublicId: string, action: string): Promise<boolean> => {
    if (args.role === 'admin') return true;
    const project = await args.db.Project.findOne({
      where: { publicId: projectPublicId },
    });
    if (!project) return false;
    const membership = await args.db.UserProject.findOne({
      where: { userId: args.userId, projectId: project.id as number },
      include: [{ model: args.db.ProjectPolicy }],
    });
    if (!membership) return false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const policy = (membership as any).policy;
    return policyAllows(
      {
        permissions: policy.permissions as string[],
        notPermissions: policy.notPermissions as string[],
      },
      action
    );
  };
};
