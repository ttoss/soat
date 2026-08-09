import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { buildSrn } from 'src/lib/iam';
import { getWorkflow } from 'src/lib/workflows';
import {
  getWorkflowVersion,
  listWorkflowVersions,
  restoreWorkflowVersion,
} from 'src/lib/workflowVersions';

import { parsePagination, requireAuth } from './helpers';

/**
 * Workflow state-machine version history (issue #882).
 *
 * Versions are never written through this router: they are archived by the
 * shared workflow write path, so this surface is read-only apart from `restore`,
 * which expresses itself as an ordinary workflow update carrying an archived
 * definition.
 *
 * A separate router, mounted onto `workflowsRouter`, mirroring how
 * `orchestrationVersions.ts` hangs off the orchestrations router.
 */
export const workflowVersionsRouter = new Router<Context>();

/** Path-param `{version}` is a version *number*, not a public ID. */
const parseVersionParam = (raw: string): number => {
  const version = Number(raw);
  if (!Number.isInteger(version) || version < 1) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'version must be a positive integer.'
    );
  }
  return version;
};

/**
 * Authorizes against the workflow itself, the way every other workflow route
 * does: the workflow is fetched first (a missing one is a 404 before any
 * permission is consulted) and the action is checked against its SRN.
 */
const authorizeWorkflow = async (
  ctx: Context,
  action: string
): Promise<string | null> => {
  requireAuth(ctx);

  const workflowId = ctx.params['workflow_id'] as string;
  const workflow = await getWorkflow({ id: workflowId });

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: workflow.project_id!,
    action,
    resource: buildSrn({
      projectPublicId: workflow.project_id!,
      resourceType: 'workflow',
      resourceId: workflow.id,
    }),
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }
  return workflowId;
};

/**
 * @openapi
 * Managed via packages/server/src/rest/openapi/v1/workflows.yaml
 */
workflowVersionsRouter.get(
  '/workflows/:workflow_id/versions',
  async (ctx: Context) => {
    const workflowId = await authorizeWorkflow(
      ctx,
      'workflows:ListWorkflowVersions'
    );
    if (workflowId === null) return;

    ctx.body = await listWorkflowVersions({
      workflowId,
      ...parsePagination(ctx),
    });
  }
);

workflowVersionsRouter.get(
  '/workflows/:workflow_id/versions/:version',
  async (ctx: Context) => {
    const workflowId = await authorizeWorkflow(
      ctx,
      'workflows:GetWorkflowVersion'
    );
    if (workflowId === null) return;

    ctx.body = await getWorkflowVersion({
      workflowId,
      version: parseVersionParam(ctx.params['version'] as string),
    });
  }
);

workflowVersionsRouter.post(
  '/workflows/:workflow_id/versions/:version/restore',
  async (ctx: Context) => {
    const workflowId = await authorizeWorkflow(
      ctx,
      'workflows:RestoreWorkflowVersion'
    );
    if (workflowId === null) return;

    const body = ctx.request.body as { label?: unknown };

    ctx.body = await restoreWorkflowVersion({
      workflowId,
      version: parseVersionParam(ctx.params['version'] as string),
      label: typeof body.label === 'string' ? body.label : undefined,
      createdByUserId: ctx.authUser?.id,
    });
  }
);
