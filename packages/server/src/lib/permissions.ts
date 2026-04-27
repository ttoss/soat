import type { DB } from '../db';
import {
  evaluatePolicies,
  evaluatePoliciesMultiResource,
  type PolicyDocument,
} from './iam';

export const createApiKeyIsAllowed = (args: {
  apiKeyProjectPublicId?: string;
  userPolicyIds: number[];
  apiKeyPolicyIds: number[];
  db: DB;
}) => {
  return async (reqArgs: {
    projectPublicId: string;
    action: string;
    resource?: string;
    resources?: string[];
    context?: Record<string, string>;
  }): Promise<boolean> => {
    // Hard project scope: if the key is scoped to a project, reject cross-project access
    if (
      args.apiKeyProjectPublicId &&
      reqArgs.projectPublicId !== args.apiKeyProjectPublicId
    ) {
      return false;
    }

    const userPolicies =
      args.userPolicyIds.length > 0
        ? await args.db.Policy.findAll({ where: { id: args.userPolicyIds } })
        : [];

    const userDocs = userPolicies.map((p: InstanceType<DB['Policy']>) => {
      return p.document as PolicyDocument;
    });

    const evalUser = (resources?: string[], resource?: string) => {
      if (resources && resources.length > 0) {
        return evaluatePoliciesMultiResource({
          policies: userDocs,
          action: reqArgs.action,
          resources,
          context: reqArgs.context,
        });
      }
      return evaluatePolicies({
        policies: userDocs,
        action: reqArgs.action,
        resource,
        context: reqArgs.context,
      });
    };

    // No key policies: user policies alone determine access (key inherits user permissions)
    if (args.apiKeyPolicyIds.length === 0) {
      return evalUser(reqArgs.resources, reqArgs.resource);
    }

    // Intersection: both user policies AND key policies must allow
    const userOk = evalUser(reqArgs.resources, reqArgs.resource);
    if (!userOk) return false;

    const keyPolicies = await args.db.Policy.findAll({
      where: { id: args.apiKeyPolicyIds },
    });
    const keyDocs = keyPolicies.map((p: InstanceType<DB['Policy']>) => {
      return p.document as PolicyDocument;
    });

    if (reqArgs.resources && reqArgs.resources.length > 0) {
      return evaluatePoliciesMultiResource({
        policies: keyDocs,
        action: reqArgs.action,
        resources: reqArgs.resources,
        context: reqArgs.context,
      });
    }

    return evaluatePolicies({
      policies: keyDocs,
      action: reqArgs.action,
      resource: reqArgs.resource,
      context: reqArgs.context,
    });
  };
};

export const createJwtIsAllowed = (args: {
  role: 'admin' | 'user';
  userPolicyIds: number[];
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

    if (args.userPolicyIds.length === 0) return false;

    const policies = await args.db.Policy.findAll({
      where: { id: args.userPolicyIds },
    });
    const policyDocs = policies.map((p: InstanceType<DB['Policy']>) => {
      return p.document as PolicyDocument;
    });

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
