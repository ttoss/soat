import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { buildSrn } from 'src/lib/iam';
import { resolveConverterRefs } from 'src/lib/ingestionRuleRefs';
import {
  createIngestionRule,
  deleteIngestionRule,
  getIngestionRule,
  listIngestionRules,
  updateIngestionRule,
} from 'src/lib/ingestionRules';
import { setAuditResourceHint } from 'src/middleware/audit';

import {
  requireAuth,
  requireProjectAccess,
  resolveReadProjectIds,
  resolveWriteProjectId,
} from './helpers';

const ingestionRulesRouter = new Router<Context>();

type CreateBody = {
  project_id?: string;
  content_type_glob: string;
  tool_id?: string | null;
  agent_id?: string | null;
  action?: string | null;
  preset_parameters?: object | null;
  native_extraction?: 'first' | 'skip';
  file_delivery?: 'base64' | 'download_url';
  chunk_strategy?: string | null;
  chunk_size?: number | null;
  chunk_overlap?: number | null;
  metadata?: object | null;
};

type UpdateBody = Partial<Omit<CreateBody, 'projectId' | 'contentTypeGlob'>> & {
  contentTypeGlob?: string;
};

ingestionRulesRouter.get('/ingestion-rules', async (ctx: Context) => {
  requireAuth(ctx);
  const projectPublicId = ctx.query.project_id as string | undefined;
  const limit = ctx.query.limit
    ? parseInt(ctx.query.limit as string, 10)
    : undefined;
  const offset = ctx.query.offset
    ? parseInt(ctx.query.offset as string, 10)
    : undefined;

  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId,
    action: 'ingestion-rules:ListIngestionRules',
    resourceType: 'ingestionRule',
  });
  ctx.body = await listIngestionRules({ projectIds, limit, offset });
});

ingestionRulesRouter.get(
  '/ingestion-rules/:ingestion_rule_id',
  async (ctx: Context) => {
    requireAuth(ctx);
    const projectIds = await resolveReadProjectIds({
      ctx,
      action: 'ingestion-rules:GetIngestionRule',
      resourceType: 'ingestionRule',
    });
    // Scoping the fetch, rather than checking permission after an unscoped
    // lookup, converges "doesn't exist" and "exists elsewhere" into one 404 —
    // a cross-project id must not be distinguishable from a nonexistent one.
    ctx.body = await getIngestionRule({
      projectIds,
      id: ctx.params.ingestion_rule_id,
    });
  }
);

ingestionRulesRouter.post('/ingestion-rules', async (ctx: Context) => {
  requireAuth(ctx);
  const body = ctx.request.body as CreateBody;

  const targetProjectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.project_id,
    action: 'ingestion-rules:CreateIngestionRule',
    resourceType: 'ingestionRule',
  });
  const refs = await resolveConverterRefs({
    projectIds: [Number(targetProjectId)],
    toolId: body.tool_id,
    agentId: body.agent_id,
  });

  const rule = await createIngestionRule({
    projectId: Number(targetProjectId),
    contentTypeGlob: body.content_type_glob,
    toolId: refs.toolId,
    agentId: refs.agentId,
    action: body.action,
    presetParameters: body.preset_parameters,
    nativeExtraction: body.native_extraction,
    fileDelivery: body.file_delivery,
    chunkStrategy: body.chunk_strategy,
    chunkSize: body.chunk_size,
    chunkOverlap: body.chunk_overlap,
    metadata: body.metadata,
  });

  ctx.status = 201;
  ctx.body = rule;
});

ingestionRulesRouter.patch(
  '/ingestion-rules/:ingestion_rule_id',
  async (ctx: Context) => {
    requireAuth(ctx);
    const projectIds = await requireProjectAccess({
      ctx,
      action: 'ingestion-rules:UpdateIngestionRule',
      resourceType: 'ingestionRule',
    });
    const body = ctx.request.body as UpdateBody;

    const refs = await resolveConverterRefs({
      projectIds,
      toolId: body.tool_id,
      agentId: body.agent_id,
    });

    ctx.body = await updateIngestionRule({
      id: ctx.params.ingestion_rule_id,
      projectIds,
      contentTypeGlob: body.content_type_glob,
      toolId: refs.toolId,
      agentId: refs.agentId,
      action: body.action,
      presetParameters: body.preset_parameters,
      nativeExtraction: body.native_extraction,
      fileDelivery: body.file_delivery,
      chunkStrategy: body.chunk_strategy,
      chunkSize: body.chunk_size,
      chunkOverlap: body.chunk_overlap,
      metadata: body.metadata,
    });
  }
);

ingestionRulesRouter.delete(
  '/ingestion-rules/:ingestion_rule_id',
  async (ctx: Context) => {
    requireAuth(ctx);
    const projectIds = await requireProjectAccess({
      ctx,
      action: 'ingestion-rules:DeleteIngestionRule',
      resourceType: 'ingestionRule',
    });
    // The success response is `204 No Content`, so the audit middleware has
    // no body to backfill the project/SRN from — hand it the resolved
    // resource before the delete runs (see `setAuditResourceHint`).
    const rule = await getIngestionRule({
      id: ctx.params.ingestion_rule_id,
      projectIds,
    });
    if (rule.project_id) {
      setAuditResourceHint(ctx, {
        projectPublicId: rule.project_id,
        resourceSrn: buildSrn({
          projectPublicId: rule.project_id,
          resourceType: 'ingestionRule',
          resourceId: rule.id,
        }),
        resourcePublicId: rule.id,
      });
    }

    await deleteIngestionRule({ id: ctx.params.ingestion_rule_id, projectIds });
    ctx.status = 204;
  }
);

export { ingestionRulesRouter };
