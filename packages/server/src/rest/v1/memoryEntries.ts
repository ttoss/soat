import type { MemoryEntrySource } from '@soat/postgresdb';
import { MEMORY_ENTRY_SOURCES } from '@soat/postgresdb';
import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import { buildSrn } from 'src/lib/iam';
import { getMemory } from 'src/lib/memories';
import {
  deleteMemoryEntry,
  getMemoryEntry,
  listMemoryEntries,
  updateMemoryEntry,
  writeMemoryEntry,
} from 'src/lib/memoryEntries';

import { parsePagination } from './helpers';

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
    ctx.status = 400;
    ctx.body = { error: 'memory_id is required' };
    return null;
  }
  const memory = await getMemory({ id: memoryPublicId });
  if (!memory) {
    ctx.status = 404;
    ctx.body = { error: 'Memory not found' };
    return null;
  }
  const allowed = await ctx.authUser!.isAllowed({
    projectPublicId: memory.projectId!,
    action,
    resource: buildSrn({
      projectPublicId: memory.projectId!,
      resourceType: 'memory',
      resourceId: memory.id,
    }),
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return null;
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
    ctx.status = 404;
    ctx.body = { error: 'Memory entry not found' };
    return null;
  }
  const memory = await getMemory({ id: entry.memoryId! });
  if (!memory) {
    ctx.status = 404;
    ctx.body = { error: 'Memory entry not found' };
    return null;
  }
  const allowed = await ctx.authUser!.isAllowed({
    projectPublicId: memory.projectId!,
    action,
    resource: buildSrn({
      projectPublicId: memory.projectId!,
      resourceType: 'memoryEntry',
      resourceId: entry.id,
    }),
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return null;
  }
  return entry;
};

memoryEntriesRouter.get('/memory-entries', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const memoryRowId = await resolveMemoryForAction(
    ctx,
    ctx.query.memoryId as string | undefined,
    'memories:ListMemoryEntries'
  );
  if (memoryRowId === null) return;

  ctx.body = await listMemoryEntries({
    memoryId: memoryRowId,
    ...parsePagination(ctx),
  });
});

memoryEntriesRouter.post('/memory-entries', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const body = ctx.request.body as {
    memoryId?: string;
    content: string;
    sourceType?: string;
    tags?: unknown;
    metadata?: unknown;
    duplicateThreshold?: number;
    updateThreshold?: number;
  };

  const validationError = validateTagsMetadata(body, { allowNull: false });
  if (validationError) {
    ctx.status = 400;
    ctx.body = { error: validationError };
    return;
  }

  const memoryRowId = await resolveMemoryForAction(
    ctx,
    body.memoryId,
    'memories:CreateMemoryEntry'
  );
  if (memoryRowId === null) return;

  const result = await writeMemoryEntry({
    memoryId: memoryRowId,
    content: body.content,
    sourceType: normalizeSourceType(body.sourceType) ?? 'manual',
    tags: isStringArray(body.tags) ? body.tags : undefined,
    metadata: isPlainObject(body.metadata) ? body.metadata : undefined,
    duplicateThreshold: body.duplicateThreshold,
    updateThreshold: body.updateThreshold,
  });

  ctx.status = result.action === 'created' ? 201 : 200;
  ctx.body = { ...result.entry, action: result.action };
});

memoryEntriesRouter.get('/memory-entries/:entry_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const entry = await resolveEntryForAction(
    ctx,
    ctx.params.entry_id,
    'memories:GetMemoryEntry'
  );
  if (!entry) return;

  ctx.body = entry;
});

memoryEntriesRouter.put('/memory-entries/:entry_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

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
    ctx.status = 400;
    ctx.body = { error: validationError };
    return;
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
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

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
