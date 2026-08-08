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
import { workflowCollectionToCamel } from 'src/lib/workflowsValidation';

import {
  checkAuth,
  parsePagination,
  resolveProjectIdsWithAction,
  resolveWriteProjectId,
} from './helpers';
import { workflowVersionsRouter } from './workflowVersions';

const workflowsRouter = new Router<Context>();

/** The tag to attach to the version a write archives, when one was given. */
const parseVersionLabel = (raw: unknown): string | undefined => {
  return typeof raw === 'string' ? raw : undefined;
};

/**
 * @openapi
 * Managed via packages/server/src/rest/openapi/v1/workflows.yaml
 */
workflowsRouter.get('/workflows', async (ctx: Context) => {
  if (!checkAuth(ctx)) return;

  const projectPublicId = ctx.query.project_id as string | undefined;
  const projectIds = await resolveProjectIdsWithAction({
    ctx,
    projectPublicId,
    action: 'workflows:ListWorkflows',
    resourceType: 'workflow',
  });
  if (projectIds === null) return;

  ctx.body = await listWorkflows({
    projectIds: projectIds ?? [],
    ...parsePagination(ctx),
  });
});

workflowsRouter.get('/workflows/:workflow_id', async (ctx: Context) => {
  if (!checkAuth(ctx)) return;

  const workflow = await getWorkflow({ id: ctx.params.workflow_id });

  const allowed = await ctx.authUser!.isAllowed({
    projectPublicId: workflow.project_id!,
    action: 'workflows:GetWorkflow',
    resource: buildSrn({
      projectPublicId: workflow.project_id!,
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
    project_id?: string;
    name: string;
    description?: string | null;
    states: unknown;
    transitions: unknown;
    payload_schema?: object | null;
    version_label?: unknown;
  };

  const projectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.project_id,
    action: 'workflows:CreateWorkflow',
    resourceType: 'workflow',
  });
  if (projectId === null) return;

  const workflow = await createWorkflow({
    projectId,
    name: body.name,
    description: body.description,
    states: workflowCollectionToCamel<WorkflowState>(body.states) ?? [],
    transitions:
      workflowCollectionToCamel<WorkflowTransition>(body.transitions) ?? [],
    payloadSchema: body.payload_schema,
    versionLabel: parseVersionLabel(body.version_label),
    createdByUserId: ctx.authUser?.id,
  });

  ctx.status = 201;
  ctx.body = workflow;
});

workflowsRouter.patch('/workflows/:workflow_id', async (ctx: Context) => {
  if (!checkAuth(ctx)) return;

  const workflow = await getWorkflow({ id: ctx.params.workflow_id });

  const allowed = await ctx.authUser!.isAllowed({
    projectPublicId: workflow.project_id!,
    action: 'workflows:UpdateWorkflow',
    resource: buildSrn({
      projectPublicId: workflow.project_id!,
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
    states?: unknown;
    transitions?: unknown;
    payload_schema?: object | null;
    version_label?: unknown;
  };

  ctx.body = await updateWorkflow({
    id: ctx.params.workflow_id,
    name: body.name,
    description: body.description,
    states: workflowCollectionToCamel<WorkflowState>(body.states),
    transitions: workflowCollectionToCamel<WorkflowTransition>(
      body.transitions
    ),
    payloadSchema: body.payload_schema,
    versionLabel: parseVersionLabel(body.version_label),
    createdByUserId: ctx.authUser?.id,
  });
});

workflowsRouter.delete('/workflows/:workflow_id', async (ctx: Context) => {
  if (!checkAuth(ctx)) return;

  const workflow = await getWorkflow({ id: ctx.params.workflow_id });

  const allowed = await ctx.authUser!.isAllowed({
    projectPublicId: workflow.project_id!,
    action: 'workflows:DeleteWorkflow',
    resource: buildSrn({
      projectPublicId: workflow.project_id!,
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

// The version-history surface lives in its own file and hangs off this router,
// mirroring `orchestrationVersions.ts` under the orchestrations router.
workflowsRouter.use(workflowVersionsRouter.routes());
workflowsRouter.use(workflowVersionsRouter.allowedMethods());

export { workflowsRouter };
