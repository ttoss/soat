import {
  deleteFile,
  getFileRecord,
  listFileRecords,
  retrieveFileById,
  saveFile,
  type StorageConfig,
} from '@soat/files-core';
import { Router } from '@ttoss/http-server';

import type { Context } from '../../Context';

const defaultConfig: StorageConfig = {
  type: 'local',
  local: {
    path: '/tmp/files',
  },
};

const filesRouter = new Router<unknown, Context>();

filesRouter.get('/', async (ctx: Context) => {
  try {
    const files = await listFileRecords();
    ctx.status = 200;
    ctx.body = { success: true, files };
  } catch (error) {
    ctx.status = 500;
    ctx.body = {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
});

filesRouter.post('/upload', async (ctx: Context) => {
  try {
    const { content, options } = ctx.request.body;
    if (!content) {
      ctx.status = 400;
      ctx.body = { success: false, error: 'Content is required' };
      return;
    }
    const file = await saveFile({ config: defaultConfig, content, options });
    ctx.status = 201;
    ctx.body = {
      success: true,
      id: file.id,
      filename: options?.metadata?.filename,
    };
  } catch (error) {
    ctx.status = 500;
    ctx.body = {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
});

filesRouter.get('/:id', async (ctx: Context) => {
  try {
    const { id } = ctx.params;
    if (!id) {
      ctx.status = 400;
      ctx.body = { success: false, error: 'ID is required' };
      return;
    }
    const file = await retrieveFileById({ config: defaultConfig, id });
    if (!file) {
      ctx.status = 404;
      ctx.body = { success: false, error: 'File not found' };
      return;
    }
    const record = await getFileRecord(id);
    ctx.status = 200;
    ctx.body = { success: true, file, record };
  } catch (error) {
    ctx.status = 500;
    ctx.body = {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
});

filesRouter.delete('/:id', async (ctx: Context) => {
  try {
    const { id } = ctx.params;
    if (!id) {
      ctx.status = 400;
      ctx.body = { success: false, error: 'ID is required' };
      return;
    }
    const deleted = await deleteFile({ config: defaultConfig, id });
    if (!deleted) {
      ctx.status = 404;
      ctx.body = { success: false, error: 'File not found' };
      return;
    }
    ctx.status = 200;
    ctx.body = { success: true };
  } catch (error) {
    ctx.status = 500;
    ctx.body = {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
});

export { filesRouter };
