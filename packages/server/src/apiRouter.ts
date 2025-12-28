import { Router } from '@ttoss/http-server';

import type { Context } from './Context';
import { recallMemory } from './memory/recallMemory';
import { recordMemory } from './memory/recordMemory';

const apiRouter = new Router();

apiRouter.post('/api/memory/record', async (ctx: Context) => {
  try {
    const { content } = ctx.request.body as { content: string };

    if (!content || typeof content !== 'string') {
      ctx.status = 400;
      ctx.body = {
        success: false,
        error: 'Content is required and must be a string',
      };
      return;
    }

    const result = await recordMemory({ content });
    ctx.status = 200;
    ctx.body = result;
  } catch (error) {
    ctx.status = 500;
    ctx.body = {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
});

apiRouter.post('/api/memory/recall', async (ctx: Context) => {
  try {
    const { query, limit } = ctx.request.body as {
      query: string;
      limit?: number;
    };

    if (!query || typeof query !== 'string') {
      ctx.status = 400;
      ctx.body = {
        success: false,
        error: 'Query is required and must be a string',
      };
      return;
    }

    if (limit !== undefined && (typeof limit !== 'number' || limit < 1)) {
      ctx.status = 400;
      ctx.body = {
        success: false,
        error: 'Limit must be a positive number',
      };
      return;
    }

    const result = await recallMemory({ query, limit });
    ctx.status = 200;
    ctx.body = result;
  } catch (error) {
    ctx.status = 500;
    ctx.body = {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
});

export { apiRouter };
