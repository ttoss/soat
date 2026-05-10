import { Router } from '@ttoss/http-server';

import { AppError } from 'src/AppError';
import type { Context } from 'src/Context';
import { searchKnowledge } from 'src/lib/knowledge';
import { compilePolicy } from 'src/lib/policyCompiler';

const knowledgeRouter = new Router<Context>();

/**
 * @openapi POST /api/v1/knowledge/search
 */
knowledgeRouter.post('/knowledge/search', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const body = ctx.request.body as {
    projectId?: string;
    query?: string;
    minScore?: number;
    limit?: number;
    paths?: string[];
    documentIds?: string[];
  };

  if (!body.query && !body.paths && !body.documentIds) {
    ctx.status = 400;
    ctx.body = {
      error: 'At least one of query, paths, or documentIds is required',
    };
    return;
  }

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId: body.projectId,
    action: 'knowledge:SearchKnowledge',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  let policyWhere: Record<string, unknown> | undefined;
  if (body.projectId) {
    const policies = await ctx.authUser.getPolicies(body.projectId);
    const compiled = compilePolicy({
      policies,
      action: 'knowledge:SearchKnowledge',
      resourceType: 'document',
      projectPublicId: body.projectId,
    });
    if (!compiled.hasAccess) {
      ctx.body = { results: [] };
      return;
    }
    policyWhere = compiled.where;
  }

  try {
    const results = await searchKnowledge({
      projectIds,
      policyWhere,
      query: body.query,
      minScore: body.minScore,
      limit: body.limit,
      paths: body.paths,
      documentIds: body.documentIds,
    });
    ctx.body = { results };
  } catch (error) {
    throw new AppError({ message: 'Error searching knowledge', cause: error });
  }
});

export { knowledgeRouter };
