import createDebug from 'debug';

import type {
  DeniedPrincipal,
  Refusal,
  RefusedBy,
} from './authorizationDenial';
import {
  evaluatePolicies,
  evaluatePoliciesMultiResource,
  type PolicyDecision,
  type PolicyDocument,
  type PolicySets,
} from './iam';

const log = createDebug('soat:permissions');

/**
 * Rejects an authorization check that names no project.
 *
 * Every project authorization in the codebase funnels through
 * `createPolicySetsIsAllowed` below, which makes this the one place that can
 * make "the route failed to resolve a project" a **safe, uniform outcome** for
 * every module at once, instead of a per-module hazard.
 *
 * Without it the missing value flows onward: an admin's wildcard set allows
 * without ever inspecting `projectPublicId`, and the granted check then hands
 * `undefined` to the usage-attribution wrapper, whose `Project.findOne` throws
 * on the undefined `WHERE` binding — a raw 500 on a route that is otherwise
 * fine. Denying instead is the correct direction: a check that cannot
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
}): PolicyDecision => {
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

/** Policy sets grouped by the principal they belong to, so a refusal names it. */
export type LabeledPolicySets = {
  principal: DeniedPrincipal;
  sets: PolicySets;
}[];

export const unlabelPolicySets = (labeled: LabeledPolicySets): PolicySets => {
  return labeled.flatMap(({ sets }) => {
    return sets;
  });
};

const refusalKey = (action: string, resource?: string): string => {
  return resource === undefined ? action : `${action}\n${resource}`;
};

type PolicySetsCheck = {
  projectPublicId: string;
  action: string;
  resource?: string;
  resources?: string[];
  context?: Record<string, string>;
};

/**
 * The first group refusing `check`, with the denial of the `Deny` that
 * decided it. A group holding no set allows nothing, as one holding an empty
 * set.
 */
const findRefusal = (args: {
  groups: LabeledPolicySets;
  check: Omit<PolicySetsCheck, 'projectPublicId'>;
}): Refusal | undefined => {
  for (const { principal, sets } of args.groups) {
    if (sets.length === 0) return { principal, denial: null };
    for (const policies of sets) {
      const decision = evalDocs({ policies, ...args.check });
      if (!decision.allowed) return { principal, denial: decision.denial };
    }
  }
  return undefined;
};

/**
 * Whether `groups` allow `check`, as the request evaluator decides it, but
 * neither recorded as a refusal nor audited: for asking what else a caller may
 * do once a check is already refused.
 */
export const policyGroupsAllow = (args: {
  groups: LabeledPolicySets;
  check: Omit<PolicySetsCheck, 'projectPublicId'>;
}): boolean => {
  return findRefusal(args) === undefined;
};

/**
 * Authorizer over policy sets that must each allow the request, confined to
 * one project. `getSets` is read per check, so a revoked policy takes effect
 * on the next one. `refusedBy` names the first group whose set refused a
 * check and the denial that set's `Deny` declares; a refusal by the project
 * guards names none.
 */
export const createPolicySetsIsAllowed = (args: {
  projectPublicId?: string;
  getSets: () => Promise<LabeledPolicySets>;
}): ((reqArgs: PolicySetsCheck) => Promise<boolean>) & {
  refusedBy: RefusedBy;
} => {
  const refusals = new Map<string, Refusal>();
  const check = async (reqArgs: PolicySetsCheck): Promise<boolean> => {
    if (
      !hasProjectPublicId({
        projectPublicId: reqArgs.projectPublicId,
        action: reqArgs.action,
      })
    ) {
      return false;
    }

    // Hard project scope: a scoped credential never reaches another project.
    if (
      args.projectPublicId &&
      reqArgs.projectPublicId !== args.projectPublicId
    ) {
      return false;
    }

    const refusal = findRefusal({
      groups: await args.getSets(),
      check: reqArgs,
    });
    if (!refusal) return true;
    const resources = [
      ...(reqArgs.resource === undefined ? [] : [reqArgs.resource]),
      ...(reqArgs.resources ?? []),
    ];
    for (const key of [
      refusalKey(reqArgs.action),
      ...resources.map((resource) => {
        return refusalKey(reqArgs.action, resource);
      }),
    ]) {
      refusals.set(key, refusal);
    }
    return false;
  };
  return Object.assign(check, {
    refusedBy: ({
      action,
      resource,
    }: {
      action: string;
      resource: string | null;
    }) => {
      return (
        (resource === null
          ? undefined
          : refusals.get(refusalKey(action, resource))) ??
        refusals.get(refusalKey(action))
      );
    },
  });
};

/**
 * `around` in place of `isAllowed`, still naming what `isAllowed` refused:
 * every wrapper of a request's authorizer goes through it.
 */
export const wrapIsAllowed = <Check>(args: {
  isAllowed: ((check: Check) => Promise<boolean>) & { refusedBy?: RefusedBy };
  around: (check: Check) => Promise<boolean>;
}): ((check: Check) => Promise<boolean>) & { refusedBy?: RefusedBy } => {
  return Object.assign(args.around, { refusedBy: args.isAllowed.refusedBy });
};
