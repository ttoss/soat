import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { resolveConverterRefs } from 'src/lib/ingestionRuleRefs';
import {
  createIngestionRule,
  deleteIngestionRule,
  getIngestionRule,
  listIngestionRules,
  updateIngestionRule,
} from 'src/lib/ingestionRules';

import { checkAuth, resolveWriteProjectId } from './helpers';

const ingestionRulesRouter = new Router<Context>();

type CreateBody = {
  projectId?: string;
  contentTypeGlob: string;
  toolId?: string | null;
  agentId?: string | null;
  action?: string | null;
  presetParameters?: object | null;
  nativeExtraction?: 'first' | 'skip';
  fileDelivery?: 'base64' | 'download_url';
  chunkStrategy?: string | null;
  chunkSize?: number | null;
  chunkOverlap?: number | null;
  metadata?: object | null;
};

type UpdateBody = Partial<Omit<CreateBody, 'projectId' | 'contentTypeGlob'>> & {
  contentTypeGlob?: string;
};

ingestionRulesRouter.get('/ingestion-rules', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectPublicId = ctx.query.projectId as string | undefined;

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action: 'ingestion-rules:ListIngestionRules',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = await listIngestionRules({ projectIds });
});

ingestionRulesRouter.get(
  '/ingestion-rules/:ingestion_rule_id',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const rule = await getIngestionRule({ id: ctx.params.ingestion_rule_id });

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: rule.projectId,
      action: 'ingestion-rules:GetIngestionRule',
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    ctx.body = rule;
  }
);

ingestionRulesRouter.post('/ingestion-rules', async (ctx: Context) => {
  if (!checkAuth(ctx)) return;

  const body = ctx.request.body as CreateBody;

  const targetProjectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.projectId,
    action: 'ingestion-rules:CreateIngestionRule',
  });
  if (targetProjectId === null) return;

  const refs = await resolveConverterRefs({
    projectIds: [Number(targetProjectId)],
    toolId: body.toolId,
    agentId: body.agentId,
  });

  const rule = await createIngestionRule({
    projectId: Number(targetProjectId),
    contentTypeGlob: body.contentTypeGlob,
    toolId: refs.toolId,
    agentId: refs.agentId,
    action: body.action,
    presetParameters: body.presetParameters,
    nativeExtraction: body.nativeExtraction,
    fileDelivery: body.fileDelivery,
    chunkStrategy: body.chunkStrategy,
    chunkSize: body.chunkSize,
    chunkOverlap: body.chunkOverlap,
    metadata: body.metadata,
  });

  ctx.status = 201;
  ctx.body = rule;
});

ingestionRulesRouter.patch(
  '/ingestion-rules/:ingestion_rule_id',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const existing = await getIngestionRule({
      id: ctx.params.ingestion_rule_id,
    });

    const projectIds = await ctx.authUser.resolveProjectIds({
      projectPublicId: existing.projectId,
      action: 'ingestion-rules:UpdateIngestionRule',
    });
    if (projectIds === null) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const body = ctx.request.body as UpdateBody;

    const refs = await resolveConverterRefs({
      projectIds: projectIds ?? [],
      toolId: body.toolId,
      agentId: body.agentId,
    });

    ctx.body = await updateIngestionRule({
      id: ctx.params.ingestion_rule_id,
      projectIds,
      contentTypeGlob: body.contentTypeGlob,
      toolId: refs.toolId,
      agentId: refs.agentId,
      action: body.action,
      presetParameters: body.presetParameters,
      nativeExtraction: body.nativeExtraction,
      fileDelivery: body.fileDelivery,
      chunkStrategy: body.chunkStrategy,
      chunkSize: body.chunkSize,
      chunkOverlap: body.chunkOverlap,
      metadata: body.metadata,
    });
  }
);

ingestionRulesRouter.delete(
  '/ingestion-rules/:ingestion_rule_id',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const existing = await getIngestionRule({
      id: ctx.params.ingestion_rule_id,
    });

    const projectIds = await ctx.authUser.resolveProjectIds({
      projectPublicId: existing.projectId,
      action: 'ingestion-rules:DeleteIngestionRule',
    });
    if (projectIds === null) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    await deleteIngestionRule({ id: ctx.params.ingestion_rule_id, projectIds });
    ctx.status = 204;
  }
);

export { ingestionRulesRouter };
