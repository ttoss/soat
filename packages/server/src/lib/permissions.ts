import createDebug from 'debug';

import type { DB } from '../db';
import {
  evaluatePolicies,
  evaluatePoliciesMultiResource,
  type PolicyDocument,
} from './iam';

const log = createDebug('soat:permissions');

/**
 * Rejects an authorization check that names no project.
 *
 * Every project authorization in the codebase funnels through one of the
 * `isAllowed` implementations below, which makes this the one place that can
 * make "the route failed to resolve a project" a **safe, uniform outcome** for
 * every module at once, instead of a per-module hazard.
 *
 * Without it the missing value flows onward: the admin branch returns `true`
 * without ever inspecting `projectPublicId`, and the granted check then hands
 * `undefined` to the usage-attribution wrapper, whose `Project.findOne` throws
 * on the undefined `WHERE` binding — a raw 500 on a route that is otherwise
 * fine (#801). Denying instead is the correct direction: a check that cannot
 * name its project has not proven access to one, so it gets `403`, no usage is
 * attributed, and the cause is logged rather than swallowed.
 *
 * This is a backstop, not the contract. `ProjectOwned` in `rest/v1/helpers.ts`
 * is what makes a resource missing `project_id` a compile error; this catches
 * the paths types cannot reach (an association that resolved empty, a project
 * deleted mid-request).
 */
const hasProjectPublicId = (args: {
  projectPublicId: string;
  action: string;
}): boolean => {
  if (typeof args.projectPublicId === 'string' && args.projectPublicId !== '') {
    return true;
  }
  log(
    'isAllowed: denying action=%s — no projectPublicId (got %o)',
    args.action,
    args.projectPublicId
  );
  return false;
};

/** Evaluates a policy set against either a single resource or a resource list. */
const evalDocs = (args: {
  policies: PolicyDocument[];
  action: string;
  resource?: string;
  resources?: string[];
  context?: Record<string, string>;
}): boolean => {
  if (args.resources && args.resources.length > 0) {
    return evaluatePoliciesMultiResource({
      policies: args.policies,
      action: args.action,
      resources: args.resources,
      context: args.context,
    });
  }
  return evaluatePolicies({
    policies: args.policies,
    action: args.action,
    resource: args.resource,
    context: args.context,
  });
};

/**
 * Resolves the credential boundary policy set: inline docs (OAuth consent) take
 * precedence, otherwise the key's attached policies loaded by id. Returns `null`
 * when there is no boundary (the credential inherits the user's permissions).
 */
const resolveBoundaryDocs = async (args: {
  boundaryPolicyDocs?: PolicyDocument[];
  apiKeyPolicyIds: number[];
  db: DB;
}): Promise<PolicyDocument[] | null> => {
  if (args.boundaryPolicyDocs) return args.boundaryPolicyDocs;
  if (args.apiKeyPolicyIds.length === 0) return null;
  const keyPolicies = await args.db.Policy.findAll({
    where: { id: args.apiKeyPolicyIds },
  });
  return keyPolicies.map((p: InstanceType<DB['Policy']>) => {
    return p.document as PolicyDocument;
  });
};

/**
 * Authorizer for a "scoped credential" — an API key or an OAuth access token.
 *
 * Both are modelled the same way: the owning user's policies form the ceiling,
 * and a per-credential boundary (the key's attached policies, or an OAuth
 * token's consented scope) further restricts access via intersection — the
 * credential can never exceed the user.
 *
 * The boundary policies are supplied either by id (`apiKeyPolicyIds`, loaded
 * from the DB) or inline (`boundaryPolicyDocs`, e.g. an OAuth consent policy
 * reconstructed from the token's scope claim). When neither is present the
 * credential inherits the user's permissions unchanged.
 */
export const createApiKeyIsAllowed = (args: {
  apiKeyProjectPublicId?: string;
  userRole: 'admin' | 'user';
  userPolicyIds: number[];
  apiKeyPolicyIds: number[];
  boundaryPolicyDocs?: PolicyDocument[];
  db: DB;
}) => {
  return async (reqArgs: {
    projectPublicId: string;
    action: string;
    resource?: string;
    resources?: string[];
    context?: Record<string, string>;
  }): Promise<boolean> => {
    if (
      !hasProjectPublicId({
        projectPublicId: reqArgs.projectPublicId,
        action: reqArgs.action,
      })
    ) {
      return false;
    }

    // Hard project scope: if the key is scoped to a project, reject cross-project access
    if (
      args.apiKeyProjectPublicId &&
      reqArgs.projectPublicId !== args.apiKeyProjectPublicId
    ) {
      return false;
    }

    // Admin users bypass policy evaluation — their user boundary is always satisfied
    const userIsAdmin = args.userRole === 'admin';

    const userPolicies =
      !userIsAdmin && args.userPolicyIds.length > 0
        ? await args.db.Policy.findAll({ where: { id: args.userPolicyIds } })
        : [];

    const userDocs = userPolicies.map((p: InstanceType<DB['Policy']>) => {
      return p.document as PolicyDocument;
    });

    // Admin role always satisfies the user boundary; otherwise evaluate the
    // user's own policies.
    const evalUser = (): boolean => {
      if (userIsAdmin) return true;
      return evalDocs({
        policies: userDocs,
        action: reqArgs.action,
        resource: reqArgs.resource,
        resources: reqArgs.resources,
        context: reqArgs.context,
      });
    };

    const keyDocs = await resolveBoundaryDocs({
      boundaryPolicyDocs: args.boundaryPolicyDocs,
      apiKeyPolicyIds: args.apiKeyPolicyIds,
      db: args.db,
    });

    // No boundary: user policies alone determine access (inherit user permissions)
    if (keyDocs === null) {
      return evalUser();
    }

    // Intersection: both user policies AND the credential boundary must allow
    if (!evalUser()) return false;

    return evalDocs({
      policies: keyDocs,
      action: reqArgs.action,
      resource: reqArgs.resource,
      resources: reqArgs.resources,
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
    if (
      !hasProjectPublicId({
        projectPublicId: reqArgs.projectPublicId,
        action: reqArgs.action,
      })
    ) {
      return false;
    }

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
