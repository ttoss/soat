import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import {
  exportPlaybookCaseNode,
  getPlaybookCaseExport,
  listPlaybookCaseExports,
} from 'src/lib/playbookExports';

import {
  parsePagination,
  requestPrincipalFromCtx,
  requireAuth,
} from './helpers';
import { playbookCaseAccess } from './playbookAccess';

const playbookExportsRouter = new Router<Context>();

const parseString = (value: unknown): string | undefined => {
  return typeof value === 'string' ? value : undefined;
};

/**
 * @openapi
 * /api/v1/playbook-cases/{case_id}/nodes/{node}/exports:
 *   post:
 *     $ref: 'openapi/v1/playbooks.yaml#/paths/~1api~1v1~1playbook-cases~1{case_id}~1nodes~1{node}~1exports/post'
 */
playbookExportsRouter.post(
  '/playbook-cases/:case_id/nodes/:node/exports',
  async (ctx: Context) => {
    const { projectIds } = await playbookCaseAccess.authorizeWrite({
      ctx,
      action: 'playbooks:ExportPlaybookCaseNode',
    });
    requireAuth(ctx);
    const body = ctx.request.body as Record<string, unknown>;

    ctx.status = 201;
    ctx.body = await exportPlaybookCaseNode({
      projectIds,
      caseId: ctx.params.case_id,
      node: ctx.params.node,
      transformations: body.transformations,
      revision: body.revision,
      wait: body.wait === true,
      createdBy: requestPrincipalFromCtx(ctx),
      onBehalfOf: ctx.authUser.onBehalfOf ?? null,
    });
  }
);

/**
 * @openapi
 * /api/v1/playbook-cases/{case_id}/exports:
 *   get:
 *     $ref: 'openapi/v1/playbooks.yaml#/paths/~1api~1v1~1playbook-cases~1{case_id}~1exports/get'
 */
playbookExportsRouter.get(
  '/playbook-cases/:case_id/exports',
  async (ctx: Context) => {
    const { projectIds } = await playbookCaseAccess.authorizeRead({
      ctx,
      action: 'playbooks:ListPlaybookCaseExports',
    });
    ctx.body = await listPlaybookCaseExports({
      projectIds,
      caseId: ctx.params.case_id,
      node: parseString(ctx.query.node),
      transformation: parseString(ctx.query.transformation),
      ...parsePagination(ctx),
    });
  }
);

/**
 * @openapi
 * /api/v1/playbook-cases/{case_id}/exports/{export_id}:
 *   get:
 *     $ref: 'openapi/v1/playbooks.yaml#/paths/~1api~1v1~1playbook-cases~1{case_id}~1exports~1{export_id}/get'
 */
playbookExportsRouter.get(
  '/playbook-cases/:case_id/exports/:export_id',
  async (ctx: Context) => {
    const { projectIds } = await playbookCaseAccess.authorizeRead({
      ctx,
      action: 'playbooks:GetPlaybookCaseExport',
    });
    ctx.body = await getPlaybookCaseExport({
      projectIds,
      caseId: ctx.params.case_id,
      id: ctx.params.export_id,
    });
  }
);

export { playbookExportsRouter };
