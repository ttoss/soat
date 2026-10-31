import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { projectEmbeddingBilling } from 'src/lib/embedding';
import type { KnowledgePolicyWhere } from 'src/lib/knowledge';
import { searchKnowledge } from 'src/lib/knowledge';
import {
  hasMetadataFilter,
  type MetadataFilter,
  readMetadataFilter,
} from 'src/lib/structuredFilter';
import { hasTagFilter, readTagBag } from 'src/lib/tags';

import {
  type AuthenticatedContext,
  requireAuth,
  resolveEmbeddingSpendProjectId,
  resolveReadProjectIds,
} from './helpers';
import { compileAcrossPolicySets, readScopePolicySets } from './readPolicy';

const knowledgeRouter = new Router<Context>();

type KnowledgeSearchBody = {
  project_id?: string;
  query?: string;
  min_similarity?: number;
  rrf_k?: number;
  recency_half_life_days?: number;
  limit?: number;
  // Array-typed filters. Typed loosely to tolerate non-conforming clients that
  // send a single value as a bare scalar; `toStringArray` normalizes them.
  memory_store_ids?: string[] | string;
  document_paths?: string[] | string;
  document_ids?: string[] | string;
  tags?: unknown;
  metadata?: unknown;
  include_documents?: boolean;
  include_memories?: boolean;
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
  tags: Record<string, string> | undefined,
  metadata: MetadataFilter | undefined
): boolean => {
  const hasDocumentFilters =
    (body.document_paths !== undefined && body.document_paths.length > 0) ||
    (body.document_ids !== undefined && body.document_ids.length > 0) ||
    hasMetadataFilter(metadata);
  const hasMemoryStoreFilters =
    body.memory_store_ids !== undefined && body.memory_store_ids.length > 0;
  return (
    Boolean(body.query) ||
    hasDocumentFilters ||
    hasMemoryStoreFilters ||
    hasTagFilter(tags)
  );
};

/**
 * Compiles the caller's `knowledge:SearchKnowledge` policy once per resource
 * type the search reads, over every project it spans. A statement reaches only
 * the types its SRN names, so each type answers access on its own: no access
 * to documents returns nothing, and no access to memories or their stores
 * leaves the memory half out.
 */
const resolvePolicyWhere = async (args: {
  ctx: AuthenticatedContext;
  projectPublicId: string | undefined;
  projectIds: number[] | undefined;
}): Promise<{
  forbidden: boolean;
  memoriesForbidden?: boolean;
  policyWhere?: KnowledgePolicyWhere;
}> => {
  const policySets = await readScopePolicySets(args);
  const compileFor = (compileArgs: {
    resourceType: string;
    columnRoot?: string;
  }) => {
    return compileAcrossPolicySets({
      policySets,
      action: 'knowledge:SearchKnowledge',
      resourceType: compileArgs.resourceType,
      columnRoot: compileArgs.columnRoot,
    });
  };

  const document = compileFor({
    resourceType: 'document',
    // The document half ranks `DocumentChunk` rows, so a document column is
    // reached through the `document` association rather than on the query root.
    columnRoot: 'document',
  });
  if (!document.hasAccess) return { forbidden: true };

  // The memory store half roots at `Memory` with `MemoryStore` joined, and each
  // clause is applied to the model whose columns it names — no root rewrite.
  const memoryStore = compileFor({ resourceType: 'memory_store' });
  const memory = compileFor({ resourceType: 'memory' });

  return {
    forbidden: false,
    memoriesForbidden: !memoryStore.hasAccess || !memory.hasAccess,
    policyWhere: {
      document: document.where,
      memoryStore: memoryStore.where,
      memory: memory.where,
    },
  };
};

knowledgeRouter.post('/knowledge/search', async (ctx: Context) => {
  requireAuth(ctx);

  const body = ctx.request.body as KnowledgeSearchBody;
  const tags = readTagBag(body.tags);
  const metadata = readMetadataFilter(body.metadata);

  if (!hasSearchFilters(body, tags, metadata)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'At least one of query, tags, metadata, memory_store_ids, document_paths, or document_ids is required'
    );
  }

  // Refused rather than answered `[]`: a search of no stores is a request the
  // caller cannot have meant, and an empty result would read as "nothing
  // matched".
  if (body.include_documents === false && body.include_memories === false) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'include_documents and include_memories cannot both be false'
    );
  }

  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId: body.project_id,
    action: 'knowledge:SearchKnowledge',
    resourceType: 'document',
  });

  const { forbidden, memoriesForbidden, policyWhere } =
    await resolvePolicyWhere({
      ctx,
      projectPublicId: body.project_id,
      projectIds,
    });
  if (forbidden) {
    ctx.body = { results: [] };
    return;
  }

  // One query embedding, billed once, and only when there is a query to embed.
  const billedProjectId = body.query
    ? await resolveEmbeddingSpendProjectId({ ctx, scope: projectIds })
    : null;

  const results = await searchKnowledge({
    projectIds,
    embeddingBilling: projectEmbeddingBilling({ projectId: billedProjectId }),
    policyWhere,
    query: body.query,
    minSimilarity: body.min_similarity,
    rrfK: body.rrf_k,
    recencyHalfLifeDays: body.recency_half_life_days,
    limit: body.limit,
    paths: toStringArray(body.document_paths),
    documentIds: toStringArray(body.document_ids),
    memoryStoreIds: toStringArray(body.memory_store_ids),
    tags,
    metadata,
    includeDocuments: body.include_documents,
    includeMemories: memoriesForbidden ? false : body.include_memories,
  });
  ctx.body = { results };
});

export { knowledgeRouter };
