import type { MemoryEntrySource } from '@soat/postgresdb';
import { MEMORY_ENTRY_SOURCES } from '@soat/postgresdb';
import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import { DomainError } from 'src/errors';
import { buildSrn } from 'src/lib/iam';
import { getMemory } from 'src/lib/memories';
import {
  deleteMemoryEntry,
  getMemoryEntry,
  listMemoryEntries,
  updateMemoryEntry,
  writeMemoryEntry,
} from 'src/lib/memoryEntries';

import { parsePagination, requireAuth } from './helpers';

export const memoryEntriesRouter = new Router<Context>();

const normalizeSourceType = (value: unknown): MemoryEntrySource | undefined => {
  return MEMORY_ENTRY_SOURCES.includes(value as MemoryEntrySource)
    ? (value as MemoryEntrySource)
    : undefined;
};

const isStringArray = (value: unknown): value is string[] => {
  return (
    Array.isArray(value) &&
    value.every((v) => {
      return typeof v === 'string';
    })
  );
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
    !isStringArray(body.tags)
  ) {
    return 'tags must be an array of strings';
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

// Memory entries are a top-level resource (/memory-entries) but every entry
// belongs to a memory; access is governed by the owning memory's project.

/**
 * Resolves the memory a request targets (by public id) and verifies the caller
 * may perform `action` on it. Returns the memory's internal id, or null after
 * setting the appropriate error response.
 */
const resolveMemoryForAction = async (
  ctx: Context,
  memoryPublicId: string | undefined,
  action: string
): Promise<number | null> => {
  if (!memoryPublicId) {
    throw new DomainError('VALIDATION_FAILED', 'memory_id is required');
  }
  const memory = await getMemory({ id: memoryPublicId });
  if (!memory) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Memory not found');
  }
  const allowed = await ctx.authUser!.isAllowed({
    projectPublicId: memory.project_id!,
    action,
    resource: buildSrn({
      projectPublicId: memory.project_id!,
      resourceType: 'memory',
      resourceId: memory.id,
    }),
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }
  const memoryRow = await db.Memory.findOne({
    where: { publicId: memoryPublicId },
  });
  return memoryRow!.id as number;
};

/**
 * Resolves an entry by its (globally unique) id and verifies access via the
 * owning memory's project. Returns the mapped entry, or null after setting the
 * appropriate error response.
 */
const resolveEntryForAction = async (
  ctx: Context,
  entryId: string,
  action: string
): Promise<Awaited<ReturnType<typeof getMemoryEntry>> | null> => {
  const entry = await getMemoryEntry({ id: entryId });
  if (!entry) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Memory entry not found');
  }
  const memory = await getMemory({ id: entry.memory_id! });
  if (!memory) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Memory entry not found');
  }
  const allowed = await ctx.authUser!.isAllowed({
    projectPublicId: memory.project_id!,
    action,
    resource: buildSrn({
      projectPublicId: memory.project_id!,
      resourceType: 'memoryEntry',
      resourceId: entry.id,
    }),
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }
  return entry;
};

memoryEntriesRouter.get('/memory-entries', async (ctx: Context) => {
  requireAuth(ctx);

  const memoryRowId = await resolveMemoryForAction(
    ctx,
    ctx.query.memory_id as string | undefined,
    'memories:ListMemoryEntries'
  );
  if (memoryRowId === null) return;

  ctx.body = await listMemoryEntries({
    memoryId: memoryRowId,
    includeInvalidated: ctx.query.include_invalidated === 'true',
    ...parsePagination(ctx),
  });
});

memoryEntriesRouter.post('/memory-entries', async (ctx: Context) => {
  requireAuth(ctx);

  const body = ctx.request.body as {
    memory_id?: string;
    content: string;
    source_type?: string;
    tags?: unknown;
    metadata?: unknown;
    duplicate_threshold?: number;
    update_threshold?: number;
  };

  const validationError = validateTagsMetadata(body, { allowNull: false });
  if (validationError) {
    throw new DomainError('VALIDATION_FAILED', validationError);
  }

  const memoryRowId = await resolveMemoryForAction(
    ctx,
    body.memory_id,
    'memories:CreateMemoryEntry'
  );
  if (memoryRowId === null) return;

  const result = await writeMemoryEntry({
    memoryId: memoryRowId,
    content: body.content,
    sourceType: normalizeSourceType(body.source_type) ?? 'manual',
    tags: isStringArray(body.tags) ? body.tags : undefined,
    metadata: isPlainObject(body.metadata) ? body.metadata : undefined,
    duplicateThreshold: body.duplicate_threshold,
    updateThreshold: body.update_threshold,
  });

  ctx.status = result.action === 'created' ? 201 : 200;
  ctx.body = { ...result.entry, action: result.action };
});

memoryEntriesRouter.get('/memory-entries/:entry_id', async (ctx: Context) => {
  requireAuth(ctx);

  const entry = await resolveEntryForAction(
    ctx,
    ctx.params.entry_id,
    'memories:GetMemoryEntry'
  );
  if (!entry) return;

  ctx.body = entry;
});

memoryEntriesRouter.put('/memory-entries/:entry_id', async (ctx: Context) => {
  requireAuth(ctx);

  const entry = await resolveEntryForAction(
    ctx,
    ctx.params.entry_id,
    'memories:UpdateMemoryEntry'
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

  ctx.body = await updateMemoryEntry({
    id: ctx.params.entry_id,
    content: body.content,
    tags: body.tags === undefined ? undefined : (body.tags as string[] | null),
    metadata:
      body.metadata === undefined
        ? undefined
        : (body.metadata as Record<string, unknown> | null),
  });
});

memoryEntriesRouter.delete(
  '/memory-entries/:entry_id',
  async (ctx: Context) => {
    requireAuth(ctx);

    const entry = await resolveEntryForAction(
      ctx,
      ctx.params.entry_id,
      'memories:DeleteMemoryEntry'
    );
    if (!entry) return;

    await deleteMemoryEntry({ id: ctx.params.entry_id });
    ctx.status = 204;
  }
);
