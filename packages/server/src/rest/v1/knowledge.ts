import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { searchKnowledge } from 'src/lib/knowledge';
import { compilePolicy } from 'src/lib/policyCompiler';
import { rejectUnknownFields } from 'src/lib/requestValidation';

const knowledgeRouter = new Router<Context>();

type KnowledgeSearchBody = {
  projectId?: string;
  query?: string;
  minScore?: number;
  limit?: number;
  memoryIds?: string[];
  memoryTags?: string[];
  documentPaths?: string[];
  documentIds?: string[];
};

const hasSearchFilters = (body: KnowledgeSearchBody): boolean => {
  const hasDocumentFilters =
    (body.documentPaths !== undefined && body.documentPaths.length > 0) ||
    (body.documentIds !== undefined && body.documentIds.length > 0);
  const hasMemoryFilters =
    (body.memoryIds !== undefined && body.memoryIds.length > 0) ||
    (body.memoryTags !== undefined && body.memoryTags.length > 0);
  return Boolean(body.query) || hasDocumentFilters || hasMemoryFilters;
};

const resolvePolicyWhere = async (
  ctx: Context,
  body: KnowledgeSearchBody
): Promise<{ forbidden: boolean; policyWhere?: Record<string, unknown> }> => {
  if (!body.projectId) return { forbidden: false };
  const policies = await ctx.authUser!.getPolicies(body.projectId);
  const compiled = compilePolicy({
    policies,
    action: 'knowledge:SearchKnowledge',
    resourceType: 'document',
    projectPublicId: body.projectId,
  });
  if (!compiled.hasAccess) return { forbidden: true };
  return { forbidden: false, policyWhere: compiled.where };
};

knowledgeRouter.post('/knowledge/search', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  rejectUnknownFields({
    method: 'post',
    path: '/knowledge/search',
    body: ctx.request.body as Record<string, unknown>,
  });

  const body = ctx.request.body as KnowledgeSearchBody;

  if (!hasSearchFilters(body)) {
    ctx.status = 400;
    ctx.body = {
      error:
        'At least one of query, memory_ids, memory_tags, document_paths, or document_ids is required',
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

  const { forbidden, policyWhere } = await resolvePolicyWhere(ctx, body);
  if (forbidden) {
    ctx.body = { results: [] };
    return;
  }

  const results = await searchKnowledge({
    projectIds,
    policyWhere,
    query: body.query,
    minScore: body.minScore,
    limit: body.limit,
    paths: body.documentPaths,
    documentIds: body.documentIds,
    memoryIds: body.memoryIds,
    memoryTags: body.memoryTags,
  });
  ctx.body = { results };
});

export { knowledgeRouter };
