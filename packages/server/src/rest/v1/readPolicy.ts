import type { CompiledPolicy } from 'src/lib/policyCompiler';
import {
  compileAcrossPolicySets,
  readScopePolicySets,
} from 'src/lib/scopePolicySets';

import type { AuthenticatedContext } from './helpers';

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
    policySets: await readScopePolicySets({
      getPolicies: args.ctx.authUser.getPolicies,
      projectPublicId: args.projectPublicId,
      projectIds: args.projectIds,
    }),
    action: args.action,
    resourceType: args.resourceType,
    columnRoot: args.columnRoot,
  });
};
