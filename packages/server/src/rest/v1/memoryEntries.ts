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

/**
 * @openapi
 * /api/v1/memories/{memory_id}/entries:
 *   get:
 *     operationId: listMemoryEntries
 *     x-iam-action: memories:ListMemoryEntries
 */
memoryEntriesRouter.get(
  '/memories/:memory_id/entries',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const memory = await getMemory({ id: ctx.params.memory_id });
    if (!memory) {
      ctx.status = 404;
      ctx.body = { error: 'Memory not found' };
      return;
    }

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: memory.projectId!,
      action: 'memories:ListMemoryEntries',
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const memoryRow = await db.Memory.findOne({
      where: { publicId: ctx.params.memory_id },
    });

    ctx.body = await listMemoryEntries({ memoryId: memoryRow!.id });
  }
);

/**
 * @openapi
 * /api/v1/memories/{memory_id}/entries:
 *   post:
 *     operationId: createMemoryEntry
 *     x-iam-action: memories:CreateMemoryEntry
 */
memoryEntriesRouter.post(
  '/memories/:memory_id/entries',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const memory = await getMemory({ id: ctx.params.memory_id });
    if (!memory) {
      ctx.status = 404;
      ctx.body = { error: 'Memory not found' };
      return;
    }

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: memory.projectId!,
      action: 'memories:CreateMemoryEntry',
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const body = ctx.request.body as {
      content?: string;
      source?: string;
      duplicateThreshold?: number;
      updateThreshold?: number;
    };

    if (!body.content) {
      ctx.status = 400;
      ctx.body = { error: 'content is required' };
      return;
    }

    const memoryRow = await db.Memory.findOne({
      where: { publicId: ctx.params.memory_id },
    });

    const result = await writeMemoryEntry({
      memoryId: memoryRow!.id,
      content: body.content,
      source:
        body.source === 'agent' || body.source === 'extraction'
          ? body.source
          : 'manual',
      duplicateThreshold: body.duplicateThreshold,
      updateThreshold: body.updateThreshold,
    });

    ctx.status = result.action === 'created' ? 201 : 200;
    ctx.body = { ...result.entry, action: result.action };
  }
);

/**
 * @openapi
 * /api/v1/memories/{memory_id}/entries/{entry_id}:
 *   get:
 *     operationId: getMemoryEntry
 *     x-iam-action: memories:GetMemoryEntry
 */
memoryEntriesRouter.get(
  '/memories/:memory_id/entries/:entry_id',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const memory = await getMemory({ id: ctx.params.memory_id });
    if (!memory) {
      ctx.status = 404;
      ctx.body = { error: 'Memory not found' };
      return;
    }

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: memory.projectId!,
      action: 'memories:GetMemoryEntry',
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const entry = await getMemoryEntry({ id: ctx.params.entry_id });
    if (!entry) {
      ctx.status = 404;
      ctx.body = { error: 'Memory entry not found' };
      return;
    }

    ctx.body = entry;
  }
);

/**
 * @openapi
 * /api/v1/memories/{memory_id}/entries/{entry_id}:
 *   put:
 *     operationId: updateMemoryEntry
 *     x-iam-action: memories:UpdateMemoryEntry
 */
memoryEntriesRouter.put(
  '/memories/:memory_id/entries/:entry_id',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const memory = await getMemory({ id: ctx.params.memory_id });
    if (!memory) {
      ctx.status = 404;
      ctx.body = { error: 'Memory not found' };
      return;
    }

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: memory.projectId!,
      action: 'memories:UpdateMemoryEntry',
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const entry = await getMemoryEntry({ id: ctx.params.entry_id });
    if (!entry) {
      ctx.status = 404;
      ctx.body = { error: 'Memory entry not found' };
      return;
    }

    const body = ctx.request.body as { content?: string };

    const updated = await updateMemoryEntry({
      id: ctx.params.entry_id,
      content: body.content,
    });

    ctx.body = updated;
  }
);

/**
 * @openapi
 * /api/v1/memories/{memory_id}/entries/{entry_id}:
 *   delete:
 *     operationId: deleteMemoryEntry
 *     x-iam-action: memories:DeleteMemoryEntry
 */
memoryEntriesRouter.delete(
  '/memories/:memory_id/entries/:entry_id',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const memory = await getMemory({ id: ctx.params.memory_id });
    if (!memory) {
      ctx.status = 404;
      ctx.body = { error: 'Memory not found' };
      return;
    }

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: memory.projectId!,
      action: 'memories:DeleteMemoryEntry',
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const entry = await getMemoryEntry({ id: ctx.params.entry_id });
    if (!entry) {
      ctx.status = 404;
      ctx.body = { error: 'Memory entry not found' };
      return;
    }

    await deleteMemoryEntry({ id: ctx.params.entry_id });
    ctx.status = 204;
  }
);
