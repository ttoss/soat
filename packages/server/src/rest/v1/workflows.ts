import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { buildSrn } from 'src/lib/iam';
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  listWorkflows,
  updateWorkflow,
  type WorkflowState,
  type WorkflowTransition,
} from 'src/lib/workflows';

import {
  checkAuth,
  resolveProjectIdsWithAction,
  resolveWriteProjectId,
} from './helpers';

const workflowsRouter = new Router<Context>();

/**
 * @openapi
 * Managed via packages/server/src/rest/openapi/v1/workflows.yaml
 */
workflowsRouter.get('/workflows', async (ctx: Context) => {
  if (!checkAuth(ctx)) return;

  const projectPublicId = ctx.query.projectId as string | undefined;
  const projectIds = await resolveProjectIdsWithAction({
    ctx,
    projectPublicId,
    action: 'workflows:ListWorkflows',
    resourceType: 'workflow',
  });
  if (projectIds === null) return;

  ctx.body = await listWorkflows({ projectIds: projectIds ?? [] });
});

workflowsRouter.get('/workflows/:workflow_id', async (ctx: Context) => {
  if (!checkAuth(ctx)) return;

  const workflow = await getWorkflow({ id: ctx.params.workflow_id });

  const allowed = await ctx.authUser!.isAllowed({
    projectPublicId: workflow.projectId!,
    action: 'workflows:GetWorkflow',
    resource: buildSrn({
      projectPublicId: workflow.projectId!,
      resourceType: 'workflow',
      resourceId: workflow.id,
    }),
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = workflow;
});

workflowsRouter.post('/workflows', async (ctx: Context) => {
  if (!checkAuth(ctx)) return;

  const body = ctx.request.body as {
    projectId?: string;
    name: string;
    description?: string | null;
    states: WorkflowState[];
    transitions: WorkflowTransition[];
    payloadSchema?: object | null;
  };

  const projectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.projectId,
    action: 'workflows:CreateWorkflow',
    resourceType: 'workflow',
  });
  if (projectId === null) return;

  const workflow = await createWorkflow({
    projectId,
    name: body.name,
    description: body.description,
    states: body.states,
    transitions: body.transitions,
    payloadSchema: body.payloadSchema,
  });

  ctx.status = 201;
  ctx.body = workflow;
});

workflowsRouter.patch('/workflows/:workflow_id', async (ctx: Context) => {
  if (!checkAuth(ctx)) return;

  const workflow = await getWorkflow({ id: ctx.params.workflow_id });

  const allowed = await ctx.authUser!.isAllowed({
    projectPublicId: workflow.projectId!,
    action: 'workflows:UpdateWorkflow',
    resource: buildSrn({
      projectPublicId: workflow.projectId!,
      resourceType: 'workflow',
      resourceId: workflow.id,
    }),
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const body = ctx.request.body as {
    name?: string;
    description?: string | null;
    states?: WorkflowState[];
    transitions?: WorkflowTransition[];
    payloadSchema?: object | null;
  };

  ctx.body = await updateWorkflow({
    id: ctx.params.workflow_id,
    name: body.name,
    description: body.description,
    states: body.states,
    transitions: body.transitions,
    payloadSchema: body.payloadSchema,
  });
});

workflowsRouter.delete('/workflows/:workflow_id', async (ctx: Context) => {
  if (!checkAuth(ctx)) return;

  const workflow = await getWorkflow({ id: ctx.params.workflow_id });

  const allowed = await ctx.authUser!.isAllowed({
    projectPublicId: workflow.projectId!,
    action: 'workflows:DeleteWorkflow',
    resource: buildSrn({
      projectPublicId: workflow.projectId!,
      resourceType: 'workflow',
      resourceId: workflow.id,
    }),
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  await deleteWorkflow({ id: ctx.params.workflow_id });
  ctx.status = 204;
});

export { workflowsRouter };
