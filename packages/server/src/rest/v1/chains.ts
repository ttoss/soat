import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { getChain, listChains } from 'src/lib/generationChains';

import {
  parsePagination,
  requireAuth,
  requireProjectAccess,
  resolveReadProjectIds,
} from './helpers';

const chainsRouter = new Router<Context>();

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
  requireAuth(ctx);

  // The stricter helper: this route resolves one chain and checks its project,
  // so an empty scope has to be a `403` — as `[]` it would make a chain the
  // caller may not read look like one that does not exist.
  const projectIds = await requireProjectAccess({
    ctx,
    action: 'chains:GetChain',
    resourceType: 'chain',
  });

  ctx.body = await getChain({ projectIds, id: ctx.params.chain_id });
});

export { chainsRouter };
