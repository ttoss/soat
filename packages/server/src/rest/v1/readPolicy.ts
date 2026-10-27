import { Op } from '@ttoss/postgresdb';
import type { PolicyDocument } from 'src/lib/iam';
import { type CompiledPolicy, compilePolicy } from 'src/lib/policyCompiler';
import { findProjectPublicIds } from 'src/lib/projects';

import type { AuthenticatedContext } from './helpers';

type ScopePolicySet = { projectPublicId: string; policies: PolicyDocument[] };

/**
 * The distinct policy sets a list or search spans: the named project's, or,
 * with no `project_id`, each resolved project's. `undefined` scope (an
 * unrestricted admin) spans none, so nothing narrows it.
 */
export const readScopePolicySets = async (args: {
  ctx: AuthenticatedContext;
  projectPublicId: string | undefined;
  projectIds: number[] | undefined;
}): Promise<ScopePolicySet[]> => {
  const projectPublicIds = args.projectPublicId
    ? [args.projectPublicId]
    : await findProjectPublicIds({ ids: args.projectIds ?? [] });

  const sets = await Promise.all(
    projectPublicIds.map(async (projectPublicId) => {
      return {
        projectPublicId,
        policies: await args.ctx.authUser.getPolicies(projectPublicId),
      };
    })
  );
  const distinct = new Map<string, ScopePolicySet>();
  for (const set of sets) {
    const key = JSON.stringify(set.policies);
    if (!distinct.has(key)) distinct.set(key, set);
  }
  return [...distinct.values()];
};

/**
 * Compiles `action` against every set the read spans. Several sets are
 * combined fail-closed: each must grant access and every row must pass each
 * set's clause.
 */
export const compileAcrossPolicySets = (args: {
  policySets: ScopePolicySet[];
  action: string;
  resourceType: string;
  columnRoot?: string;
}): CompiledPolicy => {
  const compiled = args.policySets.map((set) => {
    return compilePolicy({
      policies: set.policies,
      action: args.action,
      resourceType: args.resourceType,
      projectPublicId: set.projectPublicId,
      columnRoot: args.columnRoot,
    });
  });
  if (
    compiled.some((entry) => {
      return !entry.hasAccess;
    })
  ) {
    return { where: {}, hasAccess: false };
  }
  if (compiled.length === 0) return { where: {}, hasAccess: true };
  if (compiled.length === 1) return compiled[0];
  return {
    where: {
      [Op.and]: compiled.map((entry) => {
        return entry.where;
      }),
    },
    hasAccess: true,
  };
};

/**
 * The row filter a list or search applies, whether or not the caller named
 * `project_id`: without it, the read spans several projects and the filter
 * must hold in each.
 */
export const compileReadPolicy = async (args: {
  ctx: AuthenticatedContext;
  projectPublicId: string | undefined;
  projectIds: number[] | undefined;
  action: string;
  resourceType: string;
  columnRoot?: string;
}): Promise<CompiledPolicy> => {
  return compileAcrossPolicySets({
    policySets: await readScopePolicySets(args),
    action: args.action,
    resourceType: args.resourceType,
    columnRoot: args.columnRoot,
  });
};
