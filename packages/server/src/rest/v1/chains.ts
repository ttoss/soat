import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { chains, getChain, listChains } from 'src/lib/generationChains';

import { parsePagination, requireAuth, resolveReadProjectIds } from './helpers';
import { makeItemRouteAuthorizer } from './resourceAccess';

const chainsRouter = new Router<Context>();

/**
 * Every `/chains/:chain_id` route authorizes against the chain's own SRN rather than the
 * project wildcard a statement naming one chain can never match (#1339).
 */
const chainAccess = makeItemRouteAuthorizer({
  findScope: chains.findScope,
  resourceType: 'chain',
  param: 'chain_id',
  label: 'Chain',
  errorCode: 'CHAIN_NOT_FOUND',
});

// Read-only by design: a chain is written by the continuation path, never by a
// caller. There is nothing to create, and "stop this chain" is a property of the
// agent's budget (`stop_conditions`), not an operation on the record.

chainsRouter.get('/chains', async (ctx: Context) => {
  requireAuth(ctx);

  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId: ctx.query.project_id as string | undefined,
    action: 'chains:ListChains',
    resourceType: 'chain',
  });

  ctx.body = await listChains({
    projectIds: projectIds ?? [],
    status: ctx.query.status as string | undefined,
    agentId: ctx.query.agent_id as string | undefined,
    ...parsePagination(ctx),
  });
});

chainsRouter.get('/chains/:chain_id', async (ctx: Context) => {
  const { projectIds } = await chainAccess.authorizeRead({
    ctx,
    action: 'chains:GetChain',
  });

  ctx.body = await getChain({ projectIds, id: ctx.params.chain_id });
});

export { chainsRouter };
