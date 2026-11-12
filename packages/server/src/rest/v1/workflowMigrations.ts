import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { callerDenied } from 'src/lib/authorizationDenial';
import { buildSrn } from 'src/lib/iam';
import {
  getWorkflowMigration,
  startWorkflowMigration,
} from 'src/lib/workflowMigrations';
import { getWorkflow } from 'src/lib/workflows';

import { requestPrincipalFromCtx, requireAuth } from './helpers';
import { requireAllowed } from './resourceAccess';

/** Mounted onto `workflowsRouter`, like `workflowVersions.ts`. */
export const workflowMigrationsRouter = new Router<Context>();

const authorizeWorkflow = async (args: { ctx: Context; action: string }) => {
  const { ctx } = args;
  requireAuth(ctx);
  const workflow = await getWorkflow({ id: ctx.params['workflow_id'] });
  await requireAllowed({
    ctx,
    check: {
      projectPublicId: workflow.project_id!,
      action: args.action,
      resource: buildSrn({
        projectPublicId: workflow.project_id!,
        resourceType: 'workflow',
        resourceId: workflow.id,
      }),
    },
    notFound: new DomainError(
      'WORKFLOW_NOT_FOUND',
      `Workflow '${ctx.params.workflow_id}' not found.`
    ),
  });
  return workflow;
};

/**
 * @openapi
 * Managed via packages/server/src/rest/openapi/v1/workflows.yaml
 */
workflowMigrationsRouter.post(
  '/workflows/:workflow_id/migrations',
  async (ctx: Context) => {
    const workflow = await authorizeWorkflow({
      ctx,
      action: 'workflows:MigrateWorkflowTasks',
    });
    requireAuth(ctx);
    const { authUser } = ctx;
    const body = ctx.request.body as {
      to_version: number;
      state_map?: Record<string, string>;
      wait?: boolean;
    };
    const { principalType, principalId } = requestPrincipalFromCtx(ctx);

    ctx.status = 201;
    ctx.body = await startWorkflowMigration({
      workflowId: workflow.id,
      toVersion: body.to_version,
      stateMap: body.state_map,
      wait: body.wait === true,
      principal: { kind: principalType, id: principalId },
      mayMigrate: async (task) => {
        const check = {
          action: 'tasks:MigrateTask',
          resource: buildSrn({
            projectPublicId: workflow.project_id!,
            resourceType: 'task',
            resourceId: task.publicId,
          }),
        };
        const allowed = await authUser.isAllowed({
          projectPublicId: workflow.project_id!,
          ...check,
        });
        return allowed ? null : callerDenied({ authUser, ...check });
      },
    });
  }
);

workflowMigrationsRouter.get(
  '/workflows/:workflow_id/migrations/:migration_id',
  async (ctx: Context) => {
    const workflow = await authorizeWorkflow({
      ctx,
      action: 'workflows:GetWorkflowMigration',
    });
    ctx.body = await getWorkflowMigration({
      workflowId: workflow.id,
      id: ctx.params['migration_id'],
    });
  }
);
