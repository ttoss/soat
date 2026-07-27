import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { searchKnowledge } from 'src/lib/knowledge';
import { compilePolicy } from 'src/lib/policyCompiler';

const knowledgeRouter = new Router<Context>();

type KnowledgeSearchBody = {
  project_id?: string;
  query?: string;
  min_score?: number;
  limit?: number;
  // Array-typed filters. Typed loosely to tolerate non-conforming clients that
  // send a single value as a bare scalar; `toStringArray` normalizes them.
  memory_ids?: string[] | string;
  memory_tags?: string[] | string;
  document_paths?: string[] | string;
  document_ids?: string[] | string;
};

/**
 * Coerce an array-typed search filter to an array. Clients that send a single
 * value as a bare scalar (e.g. `document_paths: "/playbooks/"` instead of
 * `["/playbooks/"]`) must not crash the search — normalize the scalar into a
 * one-element array so downstream filtering treats it as a single prefix/id.
 */
const toStringArray = (
  value: string[] | string | undefined
): string[] | undefined => {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
};

const hasSearchFilters = (body: KnowledgeSearchBody): boolean => {
  const hasDocumentFilters =
    (body.document_paths !== undefined && body.document_paths.length > 0) ||
    (body.document_ids !== undefined && body.document_ids.length > 0);
  const hasMemoryFilters =
    (body.memory_ids !== undefined && body.memory_ids.length > 0) ||
    (body.memory_tags !== undefined && body.memory_tags.length > 0);
  return Boolean(body.query) || hasDocumentFilters || hasMemoryFilters;
};

const resolvePolicyWhere = async (
  ctx: Context,
  body: KnowledgeSearchBody
): Promise<{ forbidden: boolean; policyWhere?: Record<string, unknown> }> => {
  if (!body.project_id) return { forbidden: false };
  const policies = await ctx.authUser!.getPolicies(body.project_id);
  const compiled = compilePolicy({
    policies,
    action: 'knowledge:SearchKnowledge',
    resourceType: 'document',
    projectPublicId: body.project_id,
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
    projectPublicId: body.project_id,
    action: 'knowledge:SearchKnowledge',
    resourceType: 'document',
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
    minScore: body.min_score,
    limit: body.limit,
    paths: toStringArray(body.document_paths),
    documentIds: toStringArray(body.document_ids),
    memoryIds: toStringArray(body.memory_ids),
    memoryTags: toStringArray(body.memory_tags),
  });
  ctx.body = { results };
});

export { knowledgeRouter };
