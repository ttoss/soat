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

import {
  checkAuth,
  resolveProjectIdsWithAction,
  resolveWriteProjectId,
} from './helpers';

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
  if (!checkAuth(ctx)) return;

  const projectPublicId = ctx.query.projectId as string | undefined;
  const limit = ctx.query.limit
    ? parseInt(ctx.query.limit as string, 10)
    : undefined;
  const offset = ctx.query.offset
    ? parseInt(ctx.query.offset as string, 10)
    : undefined;

  const projectIds = await resolveProjectIdsWithAction({
    ctx,
    projectPublicId,
    action: 'ingestion-rules:ListIngestionRules',
    resourceType: 'ingestionRule',
  });
  if (projectIds === null) return;

  ctx.body = await listIngestionRules({ projectIds, limit, offset });
});

ingestionRulesRouter.get(
  '/ingestion-rules/:ingestion_rule_id',
  async (ctx: Context) => {
    if (!checkAuth(ctx)) return;

    const projectIds = await resolveProjectIdsWithAction({
      ctx,
      action: 'ingestion-rules:GetIngestionRule',
      resourceType: 'ingestionRule',
    });
    if (projectIds === null) return;

    // Scoping the fetch by projectIds (rather than checking permission after
    // an unscoped lookup) converges "doesn't exist" and "exists in a project
    // the caller cannot access" into the same 404 — a cross-project id must
    // not be distinguishable from a nonexistent one.
    ctx.body = await getIngestionRule({
      projectIds,
      id: ctx.params.ingestion_rule_id,
    });
  }
);

ingestionRulesRouter.post('/ingestion-rules', async (ctx: Context) => {
  if (!checkAuth(ctx)) return;

  const body = ctx.request.body as CreateBody;

  const targetProjectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.projectId,
    action: 'ingestion-rules:CreateIngestionRule',
    resourceType: 'ingestionRule',
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
    if (!checkAuth(ctx)) return;

    const projectIds = await resolveProjectIdsWithAction({
      ctx,
      action: 'ingestion-rules:UpdateIngestionRule',
      resourceType: 'ingestionRule',
    });
    if (projectIds === null) return;

    const body = ctx.request.body as UpdateBody;

    const refs = await resolveConverterRefs({
      projectIds,
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
    if (!checkAuth(ctx)) return;

    const projectIds = await resolveProjectIdsWithAction({
      ctx,
      action: 'ingestion-rules:DeleteIngestionRule',
      resourceType: 'ingestionRule',
    });
    if (projectIds === null) return;

    await deleteIngestionRule({ id: ctx.params.ingestion_rule_id, projectIds });
    ctx.status = 204;
  }
);

export { ingestionRulesRouter };
