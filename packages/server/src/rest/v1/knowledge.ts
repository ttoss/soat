import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { searchKnowledge } from 'src/lib/knowledge';
import { compilePolicy } from 'src/lib/policyCompiler';
import { hasTagFilter, readTagBag } from 'src/lib/tags';

import { requireAuth, resolveReadProjectIds } from './helpers';

const knowledgeRouter = new Router<Context>();

type KnowledgeSearchBody = {
  project_id?: string;
  query?: string;
  min_score?: number;
  limit?: number;
  // Array-typed filters. Typed loosely to tolerate non-conforming clients that
  // send a single value as a bare scalar; `toStringArray` normalizes them.
  memory_ids?: string[] | string;
  document_paths?: string[] | string;
  document_ids?: string[] | string;
  tags?: unknown;
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

const hasSearchFilters = (
  body: KnowledgeSearchBody,
  tags: Record<string, string> | undefined
): boolean => {
  const hasDocumentFilters =
    (body.document_paths !== undefined && body.document_paths.length > 0) ||
    (body.document_ids !== undefined && body.document_ids.length > 0);
  const hasMemoryFilters =
    body.memory_ids !== undefined && body.memory_ids.length > 0;
  return (
    Boolean(body.query) ||
    hasDocumentFilters ||
    hasMemoryFilters ||
    hasTagFilter(tags)
  );
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
    // The search ranks `DocumentChunk` rows, so a document column is reached
    // through the `document` association rather than on the query root.
    columnRoot: 'document',
  });
  if (!compiled.hasAccess) return { forbidden: true };
  return { forbidden: false, policyWhere: compiled.where };
};

knowledgeRouter.post('/knowledge/search', async (ctx: Context) => {
  requireAuth(ctx);

  const body = ctx.request.body as KnowledgeSearchBody;
  const tags = readTagBag(body.tags);

  if (!hasSearchFilters(body, tags)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'At least one of query, tags, memory_ids, document_paths, or document_ids is required'
    );
  }

  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId: body.project_id,
    action: 'knowledge:SearchKnowledge',
    resourceType: 'document',
  });

  const { forbidden, policyWhere } = await resolvePolicyWhere(ctx, body);
  if (forbidden) {
    ctx.body = { results: [] };
    return;
  }

  const results = await searchKnowledge({
    projectIds,
    // A search scoped to exactly one project bills its query embedding there.
    // An unscoped search (a JWT admin, or a user with several projects in
    // scope) names no single project to charge, so it is not metered.
    billingProjectId: projectIds?.length === 1 ? projectIds[0] : null,
    policyWhere,
    query: body.query,
    minScore: body.min_score,
    limit: body.limit,
    paths: toStringArray(body.document_paths),
    documentIds: toStringArray(body.document_ids),
    memoryIds: toStringArray(body.memory_ids),
    tags,
  });
  ctx.body = { results };
});

export { knowledgeRouter };
