import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import { DomainError } from 'src/errors';
import { buildSrn } from 'src/lib/iam';
import {
  assertMemoryStorageQuota,
  deleteMemory,
  findMemoryRowId,
  findThresholdOrderError,
  getMemory,
  listMemories,
  resolveMemoryThresholds,
  updateMemory,
  writeMemory,
} from 'src/lib/memories';
import { listMemoryAssertions } from 'src/lib/memoryAssertions';
import { retractMemory } from 'src/lib/memoryRetraction';
import { getMemoryStore } from 'src/lib/memoryStores';
import { getMemoryTags, updateMemoryTags } from 'src/lib/memoryTags';
import { compilePolicy } from 'src/lib/policyCompiler';
import {
  assertNoSystemTagKeys,
  buildResourceTagContext,
  isStringRecord,
  readTagQuery,
} from 'src/lib/tags';

import {
  type AuthenticatedContext,
  parsePagination,
  requestPrincipalFromCtx,
  requireAuth,
  writePreconditionOf,
} from './helpers';
import {
  isPlainObject,
  readSourcePair,
  readSupersedes,
  readThreshold,
  validateTagsMetadata,
} from './memoriesRequestBody';
import { registerTagRoutes, type TagAccess } from './tagRoutes';

export const memoriesRouter = new Router<Context>();

/**
 * A memory store id no row can carry, so the entry listing matches nothing. Used when
 * the caller holds no Allow for the action in this project: a list route
 * answers with an empty page, never an error.
 */
const NO_MEMORY = -1;

/**
 * Rejects a threshold pair that would make one of the three outcomes
 * unreachable, checked against the **effective** pair — the store's defaults
 * with this request's overrides applied. Checking the request against itself
 * would let a body that sets only one value invert it against the store's
 * other one.
 */
const assertThresholdOrder = async (args: {
  memoryStoreRowId: number;
  duplicateThreshold?: number;
  supersedeThreshold?: number;
}): Promise<void> => {
  const store = await db.MemoryStore.findByPk(args.memoryStoreRowId, {
    attributes: ['duplicateThreshold', 'supersedeThreshold'],
  });
  const error = findThresholdOrderError(
    resolveMemoryThresholds({
      store,
      duplicateThreshold: args.duplicateThreshold,
      supersedeThreshold: args.supersedeThreshold,
    })
  );
  if (error) {
    throw new DomainError('VALIDATION_FAILED', error);
  }
};

// Memories are a top-level resource (/memories) but every memory
// belongs to a memory store; access is governed by the owning memory store's project.

type LoadedMemoryStore = NonNullable<
  Awaited<ReturnType<typeof getMemoryStore>>
>;

/**
 * Resolves the memory store a request targets (by public id) and verifies the caller
 * may perform `action` on it, with the memory store's own tags as the condition
 * context. Returns the memory store and its internal id.
 */
const resolveMemoryStoreForAction = async (
  ctx: Context,
  memoryStorePublicId: string | undefined,
  action: string
): Promise<{ memoryStore: LoadedMemoryStore; memoryStoreRowId: number }> => {
  if (!memoryStorePublicId) {
    throw new DomainError('VALIDATION_FAILED', 'memory_store_id is required');
  }
  const memoryStore = await getMemoryStore({ id: memoryStorePublicId });
  if (!memoryStore) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Memory store not found');
  }
  const allowed = await ctx.authUser!.isAllowed({
    projectPublicId: memoryStore.project_id!,
    action,
    resource: buildSrn({
      projectPublicId: memoryStore.project_id!,
      resourceType: 'memory_store',
      resourceId: memoryStore.id,
    }),
    context: buildResourceTagContext({
      resourceType: 'memory_store',
      tags: memoryStore.tags,
    }),
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }
  const memoryStoreRow = await db.MemoryStore.findOne({
    where: { publicId: memoryStorePublicId },
  });
  return { memoryStore, memoryStoreRowId: memoryStoreRow!.id as number };
};

/**
 * Resolves an entry by its (globally unique) id and verifies access via the
 * owning memory store's project. Returns the mapped entry, or null after setting the
 * appropriate error response.
 */
const resolveEntryForAction = async (
  ctx: Context,
  entryId: string,
  action: string
): Promise<Awaited<ReturnType<typeof getMemory>> | null> => {
  const entry = await getMemory({ id: entryId });
  if (!entry) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Memory not found');
  }
  const memoryStore = await getMemoryStore({ id: entry.memory_store_id! });
  if (!memoryStore) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Memory not found');
  }

  // Two tag bags govern an entry, so the action is evaluated once against each.
  // An entry carries its own tags, and it is never more visible than the memory store
  // holding it: a condition that hides the memory store hides its entries too. Both
  // passes offer the same SRNs — a policy scoped to either level still matches,
  // and only the condition context differs.
  const resources = [
    buildSrn({
      projectPublicId: memoryStore.project_id!,
      resourceType: 'memory',
      resourceId: entry.id,
    }),
    buildSrn({
      projectPublicId: memoryStore.project_id!,
      resourceType: 'memory_store',
      resourceId: memoryStore.id,
    }),
  ];
  const contexts = [
    buildResourceTagContext({
      resourceType: 'memory',
      tags: entry.tags,
    }),
    buildResourceTagContext({
      resourceType: 'memory_store',
      tags: memoryStore.tags,
    }),
  ];
  for (const context of contexts) {
    const allowed = await ctx.authUser!.isAllowed({
      projectPublicId: memoryStore.project_id!,
      action,
      resources,
      context,
    });
    if (!allowed) {
      throw new DomainError('FORBIDDEN', 'Forbidden');
    }
  }

  return entry;
};

memoriesRouter.get('/memories', async (ctx: Context) => {
  requireAuth(ctx);

  const { memoryStore, memoryStoreRowId } = await resolveMemoryStoreForAction(
    ctx,
    ctx.query.memory_store_id as string | undefined,
    'memories:ListMemories'
  );

  // The memory store itself already passed the check above; this narrows the listing
  // by each entry's own tags, which the container check cannot see.
  const projectPublicId = memoryStore.project_id!;
  const policies = await ctx.authUser.getPolicies(projectPublicId);
  const { where: policyWhere, hasAccess } = compilePolicy({
    policies,
    action: 'memories:ListMemories',
    resourceType: 'memory',
    projectPublicId,
  });

  ctx.body = await listMemories({
    memoryStoreId: hasAccess ? memoryStoreRowId : NO_MEMORY,
    includeInvalidated: ctx.query.include_invalidated === 'true',
    tags: readTagQuery(ctx.query.tags),
    policyWhere,
    ...parsePagination(ctx),
  });
});

memoriesRouter.post('/memories', async (ctx: Context) => {
  requireAuth(ctx);

  const body = ctx.request.body as {
    memory_store_id?: string;
    content: string;
    source_type?: string;
    source_id?: string;
    tags?: unknown;
    metadata?: unknown;
    duplicate_threshold?: unknown;
    supersede_threshold?: unknown;
    supersedes?: unknown;
  };

  const validationError = validateTagsMetadata(body, { allowNull: false });
  if (validationError) {
    throw new DomainError('VALIDATION_FAILED', validationError);
  }

  const sourceType = readSourcePair(body);

  const { memoryStoreRowId } = await resolveMemoryStoreForAction(
    ctx,
    body.memory_store_id,
    'memories:CreateMemory'
  );

  // A declared supersede retires a memory the write grant alone does not
  // authorize touching, so the target is resolved through the same two-bag
  // check `PUT /memories/:id` uses: a declaration says no more, and does no
  // more, than updating that memory directly would. Only after the store check,
  // so the field cannot probe memories in a store the caller cannot reach at
  // all.
  const supersedes = readSupersedes(body.supersedes);
  if (supersedes) {
    await resolveEntryForAction(ctx, supersedes, 'memories:UpdateMemory');
  }

  const duplicateThreshold = readThreshold({
    value: body.duplicate_threshold,
    field: 'duplicate_threshold',
  });
  const supersedeThreshold = readThreshold({
    value: body.supersede_threshold,
    field: 'supersede_threshold',
  });
  await assertThresholdOrder({
    memoryStoreRowId,
    duplicateThreshold,
    supersedeThreshold,
  });

  await assertMemoryStorageQuota({
    memoryStoreId: memoryStoreRowId,
    content: body.content,
  });

  const result = await writeMemory({
    memoryStoreId: memoryStoreRowId,
    content: body.content,
    sourceType,
    sourceConversationPublicId: body.source_id,
    supersedes,
    tags: assertNoSystemTagKeys(
      isStringRecord(body.tags) ? body.tags : undefined
    ),
    metadata: isPlainObject(body.metadata) ? body.metadata : undefined,
    // This is the only door that takes per-request thresholds: a caller
    // addressing the corpus directly may tune one write, an agent or a rule
    // may not.
    duplicateThreshold,
    supersedeThreshold,
    assertion: {
      mechanism: 'api',
      ...requestPrincipalFromCtx(ctx),
    },
  });

  ctx.status = result.action === 'created' ? 201 : 200;
  ctx.body = { ...result.entry, action: result.action };
});

memoriesRouter.get('/memories/:memory_id', async (ctx: Context) => {
  requireAuth(ctx);

  const entry = await resolveEntryForAction(
    ctx,
    ctx.params.memory_id,
    'memories:GetMemory'
  );
  if (!entry) return;

  ctx.body = entry;
});

/**
 * @openapi
 * GET /api/v1/memories/{memory_id}/assertions
 * operationId: listMemoryAssertions
 * Returns every write that resolved into this memory — the one that created
 * it, the duplicates it absorbed, and the assertion that superseded another
 * memory in its favour, each naming the door, the principal and the similarity
 * that decided the outcome.
 */
memoriesRouter.get('/memories/:memory_id/assertions', async (ctx: Context) => {
  requireAuth(ctx);

  // Gated on the store's SRN like every other item read, through the same
  // two-bag check the memory's own routes use.
  const entry = await resolveEntryForAction(
    ctx,
    ctx.params.memory_id,
    'memories:ListMemoryAssertions'
  );
  if (!entry) return;

  ctx.body = await listMemoryAssertions({
    memoryId: (await findMemoryRowId({ id: ctx.params.memory_id }))!,
    ...parsePagination(ctx),
  });
});

memoriesRouter.put('/memories/:memory_id', async (ctx: Context) => {
  requireAuth(ctx);

  const entry = await resolveEntryForAction(
    ctx,
    ctx.params.memory_id,
    'memories:UpdateMemory'
  );
  if (!entry) return;

  const body = ctx.request.body as {
    content?: string;
    tags?: unknown;
    metadata?: unknown;
  };

  const validationError = validateTagsMetadata(body, { allowNull: true });
  if (validationError) {
    throw new DomainError('VALIDATION_FAILED', validationError);
  }

  ctx.body = await updateMemory({
    id: ctx.params.memory_id,
    content: body.content,
    tags: assertNoSystemTagKeys(
      body.tags === undefined
        ? undefined
        : (body.tags as Record<string, string> | null)
    ),
    metadata:
      body.metadata === undefined
        ? undefined
        : (body.metadata as Record<string, unknown> | null),
    expectedVersion: writePreconditionOf(ctx),
  });
});

/**
 * @openapi
 * POST /api/v1/memories/{memory_id}/retract
 * operationId: retractMemory
 * Retires a fact that stopped holding with nothing replacing it, and records
 * the retraction on the assertion ledger.
 */
memoriesRouter.post('/memories/:memory_id/retract', async (ctx: Context) => {
  requireAuth(ctx);

  const entry = await resolveEntryForAction(
    ctx,
    ctx.params.memory_id,
    'memories:RetractMemory'
  );
  if (!entry) return;

  ctx.body = await retractMemory({
    id: ctx.params.memory_id,
    expectedVersion: writePreconditionOf(ctx),
    assertion: {
      mechanism: 'api',
      ...requestPrincipalFromCtx(ctx),
    },
  });
});

const resolveEntry = async (args: {
  ctx: AuthenticatedContext;
  access: TagAccess;
}) => {
  const entry = await resolveEntryForAction(
    args.ctx,
    args.ctx.params.memory_id,
    args.access === 'read' ? 'memories:GetMemory' : 'memories:UpdateMemory'
  );
  if (!entry) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Memory not found');
  }
  return entry;
};

registerTagRoutes({
  router: memoriesRouter,
  path: '/memories/:memory_id/tags',
  resolve: resolveEntry,
  readTags: ({ resource }) => {
    return getMemoryTags({ id: resource.id });
  },
  writeTags: ({ resource, tags, merge }) => {
    return updateMemoryTags({ id: resource.id, tags, merge });
  },
});

memoriesRouter.delete('/memories/:memory_id', async (ctx: Context) => {
  requireAuth(ctx);

  const entry = await resolveEntryForAction(
    ctx,
    ctx.params.memory_id,
    'memories:DeleteMemory'
  );
  if (!entry) return;

  await deleteMemory({ id: ctx.params.memory_id });
  ctx.status = 204;
});
