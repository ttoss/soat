import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import {
  parseInputWrites,
  writePlaybookCaseInputs,
} from 'src/lib/playbookCaseInputs';
import {
  getPlaybookCaseMissing,
  listPlaybookCaseEntries,
} from 'src/lib/playbookCaseReads';
import {
  createPlaybookCase,
  deletePlaybookCase,
  getPlaybookCase,
  listPlaybookCases,
} from 'src/lib/playbookCases';

import { parsePagination, requireAuth, resolveReadProjectIds } from './helpers';
import { playbookAccess, playbookCaseAccess } from './playbookAccess';

const playbookCasesRouter = new Router<Context>();

const parseString = (value: unknown): string | undefined => {
  return typeof value === 'string' ? value : undefined;
};

/**
 * @openapi
 * /api/v1/playbooks/{playbook_id}/cases:
 *   post:
 *     $ref: 'openapi/v1/playbooks.yaml#/paths/~1api~1v1~1playbooks~1{playbook_id}~1cases/post'
 */
playbookCasesRouter.post(
  '/playbooks/:playbook_id/cases',
  async (ctx: Context) => {
    const { projectIds } = await playbookAccess.authorizeWrite({
      ctx,
      action: 'playbooks:CreatePlaybookCase',
    });
    const body = ctx.request.body as Record<string, unknown>;

    ctx.status = 201;
    ctx.body = await createPlaybookCase({
      projectIds,
      playbookId: ctx.params.playbook_id,
      subject: body.subject,
    });
  }
);

/**
 * @openapi
 * /api/v1/playbook-cases:
 *   get:
 *     $ref: 'openapi/v1/playbooks.yaml#/paths/~1api~1v1~1playbook-cases/get'
 */
playbookCasesRouter.get('/playbook-cases', async (ctx: Context) => {
  requireAuth(ctx);
  const projectIds = await resolveReadProjectIds({
    ctx,
    action: 'playbooks:ListPlaybookCases',
    resourceType: 'playbook_case',
    projectPublicId: parseString(ctx.query.project_id),
  });

  ctx.body = await listPlaybookCases({
    projectIds,
    playbookId: parseString(ctx.query.playbook_id),
    ...parsePagination(ctx),
  });
});

/**
 * @openapi
 * /api/v1/playbook-cases/{case_id}:
 *   get:
 *     $ref: 'openapi/v1/playbooks.yaml#/paths/~1api~1v1~1playbook-cases~1{case_id}/get'
 */
playbookCasesRouter.get('/playbook-cases/:case_id', async (ctx: Context) => {
  const { projectIds } = await playbookCaseAccess.authorizeRead({
    ctx,
    action: 'playbooks:GetPlaybookCase',
  });
  ctx.body = await getPlaybookCase({ projectIds, id: ctx.params.case_id });
});

/**
 * @openapi
 * /api/v1/playbook-cases/{case_id}:
 *   delete:
 *     $ref: 'openapi/v1/playbooks.yaml#/paths/~1api~1v1~1playbook-cases~1{case_id}/delete'
 */
playbookCasesRouter.delete('/playbook-cases/:case_id', async (ctx: Context) => {
  const { projectIds } = await playbookCaseAccess.authorizeWrite({
    ctx,
    action: 'playbooks:DeletePlaybookCase',
  });
  await deletePlaybookCase({ projectIds, id: ctx.params.case_id });
  ctx.status = 204;
});

/**
 * @openapi
 * /api/v1/playbook-cases/{case_id}/inputs:
 *   post:
 *     $ref: 'openapi/v1/playbooks.yaml#/paths/~1api~1v1~1playbook-cases~1{case_id}~1inputs/post'
 */
playbookCasesRouter.post(
  '/playbook-cases/:case_id/inputs',
  async (ctx: Context) => {
    const { projectIds } = await playbookCaseAccess.authorizeWrite({
      ctx,
      action: 'playbooks:WritePlaybookCaseInputs',
    });
    requireAuth(ctx);
    const body = ctx.request.body as Record<string, unknown>;

    ctx.body = await writePlaybookCaseInputs({
      projectIds,
      id: ctx.params.case_id,
      writes: parseInputWrites(body.inputs),
      createdByUserId: ctx.authUser.id,
    });
  }
);

/**
 * @openapi
 * /api/v1/playbook-cases/{case_id}/missing:
 *   get:
 *     $ref: 'openapi/v1/playbooks.yaml#/paths/~1api~1v1~1playbook-cases~1{case_id}~1missing/get'
 */
playbookCasesRouter.get(
  '/playbook-cases/:case_id/missing',
  async (ctx: Context) => {
    const { projectIds } = await playbookCaseAccess.authorizeRead({
      ctx,
      action: 'playbooks:GetPlaybookCaseMissing',
    });
    ctx.body = await getPlaybookCaseMissing({
      projectIds,
      id: ctx.params.case_id,
      node: ctx.query.node,
    });
  }
);

/**
 * @openapi
 * /api/v1/playbook-cases/{case_id}/entries:
 *   get:
 *     $ref: 'openapi/v1/playbooks.yaml#/paths/~1api~1v1~1playbook-cases~1{case_id}~1entries/get'
 */
playbookCasesRouter.get(
  '/playbook-cases/:case_id/entries',
  async (ctx: Context) => {
    const { projectIds } = await playbookCaseAccess.authorizeRead({
      ctx,
      action: 'playbooks:ListPlaybookCaseEntries',
    });
    ctx.body = await listPlaybookCaseEntries({
      projectIds,
      id: ctx.params.case_id,
      node: parseString(ctx.query.node),
      ...parsePagination(ctx),
    });
  }
);

export { playbookCasesRouter };
