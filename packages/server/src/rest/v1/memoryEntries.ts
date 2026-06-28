import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import { getMemory } from 'src/lib/memories';
import {
  deleteMemoryEntry,
  getMemoryEntry,
  listMemoryEntries,
  updateMemoryEntry,
  writeMemoryEntry,
} from 'src/lib/memoryEntries';

export const memoryEntriesRouter = new Router<Context>();

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

  ctx.body = await listMemoryEntries({ memoryId: memoryRowId });
});

memoryEntriesRouter.post('/memory-entries', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const body = ctx.request.body as {
    memoryId?: string;
    content?: string;
    sourceType?: string;
    duplicateThreshold?: number;
    updateThreshold?: number;
  };

  const memoryRowId = await resolveMemoryForAction(
    ctx,
    body.memoryId,
    'memories:CreateMemoryEntry'
  );
  if (memoryRowId === null) return;

  if (!body.content) {
    ctx.status = 400;
    ctx.body = { error: 'content is required' };
    return;
  }

  const result = await writeMemoryEntry({
    memoryId: memoryRowId,
    content: body.content,
    sourceType:
      body.sourceType === 'agent' || body.sourceType === 'extraction'
        ? body.sourceType
        : 'manual',
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

  const body = ctx.request.body as { content?: string };

  ctx.body = await updateMemoryEntry({
    id: ctx.params.entry_id,
    content: body.content,
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
