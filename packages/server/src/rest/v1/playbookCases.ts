import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { AUTOMATION_STATUSES } from 'src/lib/playbookCaseAutomation';
import {
  confirmPlaybookCaseNode,
  parseConfirmation,
} from 'src/lib/playbookCaseConfirmations';
import {
  parseInputWrites,
  writePlaybookCaseInputs,
} from 'src/lib/playbookCaseInputs';
import {
  pausePlaybookCase,
  resumePlaybookCase,
} from 'src/lib/playbookCasePause';
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
import {
  listPlaybookCaseUpgrades,
  upgradePlaybookCase,
} from 'src/lib/playbookCaseUpgrades';
import {
  getPlaybookCaseExecution,
  listPlaybookCaseExecutions,
  runPlaybookNode,
} from 'src/lib/playbookExecutions';

import {
  parseEnumListQuery,
  parsePagination,
  requestPrincipalFromCtx,
  requireAuth,
  resolveReadProjectIds,
} from './helpers';
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
    automationStatuses: parseEnumListQuery({
      ctx,
      name: 'automation_status',
      allowed: AUTOMATION_STATUSES,
    }),
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
      createdBy: requestPrincipalFromCtx(ctx),
      onBehalfOf: ctx.authUser.onBehalfOf ?? null,
      runWorkPublicId: ctx.authUser.runWorkPublicId,
      wait: body.wait === true,
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

/**
 * @openapi
 * /api/v1/playbook-cases/{case_id}/nodes/{node}/run:
 *   post:
 *     $ref: 'openapi/v1/playbooks.yaml#/paths/~1api~1v1~1playbook-cases~1{case_id}~1nodes~1{node}~1run/post'
 */
playbookCasesRouter.post(
  '/playbook-cases/:case_id/nodes/:node/run',
  async (ctx: Context) => {
    const { projectIds } = await playbookCaseAccess.authorizeWrite({
      ctx,
      action: 'playbooks:RunPlaybookCaseNode',
    });
    requireAuth(ctx);
    const body = ctx.request.body as Record<string, unknown>;

    ctx.status = 201;
    ctx.body = await runPlaybookNode({
      projectIds,
      caseId: ctx.params.case_id,
      node: ctx.params.node,
      wait: body.wait === true,
      createdBy: requestPrincipalFromCtx(ctx),
      onBehalfOf: ctx.authUser.onBehalfOf ?? null,
    });
  }
);

/**
 * @openapi
 * /api/v1/playbook-cases/{case_id}/executions:
 *   get:
 *     $ref: 'openapi/v1/playbooks.yaml#/paths/~1api~1v1~1playbook-cases~1{case_id}~1executions/get'
 */
playbookCasesRouter.get(
  '/playbook-cases/:case_id/executions',
  async (ctx: Context) => {
    const { projectIds } = await playbookCaseAccess.authorizeRead({
      ctx,
      action: 'playbooks:ListPlaybookCaseExecutions',
    });
    ctx.body = await listPlaybookCaseExecutions({
      projectIds,
      caseId: ctx.params.case_id,
      node: parseString(ctx.query.node),
      ...parsePagination(ctx),
    });
  }
);

/**
 * @openapi
 * /api/v1/playbook-cases/{case_id}/executions/{execution_id}:
 *   get:
 *     $ref: 'openapi/v1/playbooks.yaml#/paths/~1api~1v1~1playbook-cases~1{case_id}~1executions~1{execution_id}/get'
 */
playbookCasesRouter.get(
  '/playbook-cases/:case_id/executions/:execution_id',
  async (ctx: Context) => {
    const { projectIds } = await playbookCaseAccess.authorizeRead({
      ctx,
      action: 'playbooks:GetPlaybookCaseExecution',
    });
    ctx.body = await getPlaybookCaseExecution({
      projectIds,
      caseId: ctx.params.case_id,
      id: ctx.params.execution_id,
    });
  }
);

/**
 * @openapi
 * /api/v1/playbook-cases/{case_id}/pause:
 *   post:
 *     $ref: 'openapi/v1/playbooks.yaml#/paths/~1api~1v1~1playbook-cases~1{case_id}~1pause/post'
 */
playbookCasesRouter.post(
  '/playbook-cases/:case_id/pause',
  async (ctx: Context) => {
    const { projectIds } = await playbookCaseAccess.authorizeWrite({
      ctx,
      action: 'playbooks:PausePlaybookCase',
    });
    ctx.body = await pausePlaybookCase({ projectIds, id: ctx.params.case_id });
  }
);

/**
 * @openapi
 * /api/v1/playbook-cases/{case_id}/resume:
 *   post:
 *     $ref: 'openapi/v1/playbooks.yaml#/paths/~1api~1v1~1playbook-cases~1{case_id}~1resume/post'
 */
playbookCasesRouter.post(
  '/playbook-cases/:case_id/resume',
  async (ctx: Context) => {
    const { projectIds } = await playbookCaseAccess.authorizeWrite({
      ctx,
      action: 'playbooks:ResumePlaybookCase',
    });
    ctx.body = await resumePlaybookCase({ projectIds, id: ctx.params.case_id });
  }
);

/**
 * @openapi
 * /api/v1/playbook-cases/{case_id}/nodes/{node}/confirmation:
 *   post:
 *     $ref: 'openapi/v1/playbooks.yaml#/paths/~1api~1v1~1playbook-cases~1{case_id}~1nodes~1{node}~1confirmation/post'
 */
playbookCasesRouter.post(
  '/playbook-cases/:case_id/nodes/:node/confirmation',
  async (ctx: Context) => {
    const { projectIds } = await playbookCaseAccess.authorizeWrite({
      ctx,
      action: 'playbooks:ConfirmPlaybookCaseNode',
    });
    requireAuth(ctx);
    const body = ctx.request.body as Record<string, unknown>;

    ctx.body = await confirmPlaybookCaseNode({
      projectIds,
      id: ctx.params.case_id,
      node: ctx.params.node,
      confirmation: parseConfirmation(body),
      createdBy: requestPrincipalFromCtx(ctx),
      onBehalfOf: ctx.authUser.onBehalfOf ?? null,
      runWorkPublicId: ctx.authUser.runWorkPublicId,
      wait: body.wait === true,
    });
  }
);

/**
 * @openapi
 * /api/v1/playbook-cases/{case_id}/upgrade:
 *   post:
 *     $ref: 'openapi/v1/playbooks.yaml#/paths/~1api~1v1~1playbook-cases~1{case_id}~1upgrade/post'
 */
playbookCasesRouter.post(
  '/playbook-cases/:case_id/upgrade',
  async (ctx: Context) => {
    const { projectIds } = await playbookCaseAccess.authorizeWrite({
      ctx,
      action: 'playbooks:UpgradePlaybookCase',
    });
    requireAuth(ctx);
    const body = ctx.request.body as Record<string, unknown>;

    ctx.body = await upgradePlaybookCase({
      projectIds,
      id: ctx.params.case_id,
      version: body.version,
      createdBy: requestPrincipalFromCtx(ctx),
      onBehalfOf: ctx.authUser.onBehalfOf ?? null,
      runWorkPublicId: ctx.authUser.runWorkPublicId,
      wait: body.wait === true,
    });
  }
);

/**
 * @openapi
 * /api/v1/playbook-cases/{case_id}/upgrades:
 *   get:
 *     $ref: 'openapi/v1/playbooks.yaml#/paths/~1api~1v1~1playbook-cases~1{case_id}~1upgrades/get'
 */
playbookCasesRouter.get(
  '/playbook-cases/:case_id/upgrades',
  async (ctx: Context) => {
    const { projectIds } = await playbookCaseAccess.authorizeRead({
      ctx,
      action: 'playbooks:ListPlaybookCaseUpgrades',
    });
    ctx.body = await listPlaybookCaseUpgrades({
      projectIds,
      caseId: ctx.params.case_id,
      ...parsePagination(ctx),
    });
  }
);

export { playbookCasesRouter };
