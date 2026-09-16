import type { MemorySource } from '@soat/postgresdb';
import { MEMORY_SOURCES } from '@soat/postgresdb';
import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import { DomainError } from 'src/errors';
import { buildSrn } from 'src/lib/iam';
import {
  assertMemoryStorageQuota,
  deleteMemory,
  getMemory,
  listMemories,
  updateMemory,
  writeMemory,
} from 'src/lib/memories';
import { getMemoryStore } from 'src/lib/memoryStores';
import { getMemoryTags, updateMemoryTags } from 'src/lib/memoryTags';
import { compilePolicy } from 'src/lib/policyCompiler';
import {
  buildResourceTagContext,
  isStringRecord,
  readTagQuery,
} from 'src/lib/tags';

import {
  type AuthenticatedContext,
  parsePagination,
  requireAuth,
} from './helpers';
import { registerTagRoutes, type TagAccess } from './tagRoutes';

export const memoriesRouter = new Router<Context>();

/**
 * A memory store id no row can carry, so the entry listing matches nothing. Used when
 * the caller holds no Allow for the action in this project: a list route
 * answers with an empty page, never an error.
 */
const NO_MEMORY = -1;

const normalizeSourceType = (value: unknown): MemorySource | undefined => {
  return MEMORY_SOURCES.includes(value as MemorySource)
    ? (value as MemorySource)
    : undefined;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

/**
 * Validates optional `tags` / `metadata` on a request body. `allowNull` permits
 * an explicit null (used by the update route to clear a field). Returns an error
 * message, or null when the fields are valid or absent.
 */
const validateTagsMetadata = (
  body: { tags?: unknown; metadata?: unknown },
  opts: { allowNull: boolean }
): string | null => {
  const nullable = (v: unknown) => {
    return opts.allowNull && v === null;
  };
  if (
    body.tags !== undefined &&
    !nullable(body.tags) &&
    !isStringRecord(body.tags)
  ) {
    return 'tags must be an object of string values';
  }
  if (
    body.metadata !== undefined &&
    !nullable(body.metadata) &&
    !isPlainObject(body.metadata)
  ) {
    return 'metadata must be an object';
  }
  return null;
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
    duplicate_threshold?: number;
  };

  const validationError = validateTagsMetadata(body, { allowNull: false });
  if (validationError) {
    throw new DomainError('VALIDATION_FAILED', validationError);
  }

  const sourceType = normalizeSourceType(body.source_type) ?? 'manual';
  // The pair is the whole contract: `conversation` means `source_id` names the
  // conversation, `manual` means there is nothing to name. Accepting either
  // half alone would store a provenance that says one thing and points at
  // another.
  if (sourceType === 'conversation' && !body.source_id) {
    throw new DomainError(
      'VALIDATION_FAILED',
      "source_id is required when source_type is 'conversation'"
    );
  }
  if (sourceType !== 'conversation' && body.source_id) {
    throw new DomainError(
      'VALIDATION_FAILED',
      "source_id is only accepted when source_type is 'conversation'"
    );
  }

  const { memoryStoreRowId } = await resolveMemoryStoreForAction(
    ctx,
    body.memory_store_id,
    'memories:CreateMemory'
  );

  await assertMemoryStorageQuota({
    memoryStoreId: memoryStoreRowId,
    content: body.content,
  });

  const result = await writeMemory({
    memoryStoreId: memoryStoreRowId,
    content: body.content,
    sourceType,
    sourceConversationPublicId: body.source_id,
    tags: isStringRecord(body.tags) ? body.tags : undefined,
    metadata: isPlainObject(body.metadata) ? body.metadata : undefined,
    duplicateThreshold: body.duplicate_threshold,
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
    tags:
      body.tags === undefined
        ? undefined
        : (body.tags as Record<string, string> | null),
    metadata:
      body.metadata === undefined
        ? undefined
        : (body.metadata as Record<string, unknown> | null),
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
