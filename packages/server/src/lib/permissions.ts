import type { DB } from '../db';
import {
  evaluatePolicies,
  evaluatePoliciesMultiResource,
  type PolicyDocument,
} from './iam';

export const createProjectKeyIsAllowed = (args: {
  projectPublicId: string;
  userPolicyIds: number[];
  projectKeyPolicyId: number;
  db: DB;
}) => {
  return async (reqArgs: {
    projectPublicId: string;
    action: string;
    resource?: string;
    resources?: string[];
    context?: Record<string, string>;
  }): Promise<boolean> => {
    if (reqArgs.projectPublicId !== args.projectPublicId) return false;

    const [userPolicies, projectKeyPolicy] = await Promise.all([
      args.userPolicyIds.length > 0
        ? args.db.ProjectPolicy.findAll({ where: { id: args.userPolicyIds } })
        : Promise.resolve([]),
      args.db.ProjectPolicy.findOne({ where: { id: args.projectKeyPolicyId } }),
    ]);

    if (!projectKeyPolicy) return false;

    const allPolicies = [
      ...userPolicies.map((p) => p.document as PolicyDocument),
      projectKeyPolicy.document as PolicyDocument,
    ];

    if (reqArgs.resources && reqArgs.resources.length > 0) {
      // Intersection: both user policies and key policy must allow
      const userDocs = userPolicies.map((p) => p.document as PolicyDocument);
      const keyDoc = projectKeyPolicy.document as PolicyDocument;
      const userOk = evaluatePoliciesMultiResource({
        policies: userDocs,
        action: reqArgs.action,
        resources: reqArgs.resources,
        context: reqArgs.context,
      });
      if (!userOk) return false;
      return evaluatePoliciesMultiResource({
        policies: [keyDoc],
        action: reqArgs.action,
        resources: reqArgs.resources,
        context: reqArgs.context,
      });
    }

    const userAllowed = evaluatePolicies({
      policies: userPolicies.map((p) => {
        return p.document as PolicyDocument;
      }),
      action: reqArgs.action,
      resource: reqArgs.resource,
      context: reqArgs.context,
    });

    if (!userAllowed) return false;

    return evaluatePolicies({
      policies: [projectKeyPolicy.document as PolicyDocument],
      action: reqArgs.action,
      resource: reqArgs.resource,
      context: reqArgs.context,
    });
  };
};

export const createJwtIsAllowed = (args: {
  role: 'admin' | 'user';
  userId: number;
  db: DB;
}) => {
  return async (reqArgs: {
    projectPublicId: string;
    action: string;
    resource?: string;
    resources?: string[];
    context?: Record<string, string>;
  }): Promise<boolean> => {
    if (args.role === 'admin') return true;
    const project = await args.db.Project.findOne({
      where: { publicId: reqArgs.projectPublicId },
    });
    if (!project) return false;
    const membership = await args.db.UserProject.findOne({
      where: { userId: args.userId, projectId: project.id as number },
    });
    if (!membership) return false;
    const policyIds = membership.policyIds as number[];
    if (policyIds.length === 0) return false;
    const policies = await args.db.ProjectPolicy.findAll({
      where: { id: policyIds },
    });
    const policyDocs = policies.map((p) => p.document as PolicyDocument);

    if (reqArgs.resources && reqArgs.resources.length > 0) {
      return evaluatePoliciesMultiResource({
        policies: policyDocs,
        action: reqArgs.action,
        resources: reqArgs.resources,
        context: reqArgs.context,
      });
    }

    return evaluatePolicies({
      policies: policyDocs,
      action: reqArgs.action,
      resource: reqArgs.resource,
      context: reqArgs.context,
    });
  };
};
