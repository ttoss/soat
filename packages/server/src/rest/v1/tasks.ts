import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { actsForOf } from 'src/lib/actsFor';
import { parseMetadataBag, readNullableMetadataBag } from 'src/lib/metadataBag';
import { readStructuredQuery } from 'src/lib/structuredFilter';
import {
  createTask,
  deleteTask,
  getTaskHistory,
  listTaskTransitions,
  migrateTask,
  type TaskPrincipal,
  transitionTask,
  updateTask,
} from 'src/lib/tasks';
import { TASK_AUTOMATION_STATUSES } from 'src/lib/tasksAutomationStatus';
import { createTaskRequestDigest } from 'src/lib/tasksCreateIdempotency';
import { getTaskGraph } from 'src/lib/tasksGraph';
import { listTasks } from 'src/lib/tasksList';
import { pauseTask, resumeTask } from 'src/lib/tasksPauseActions';
import { TASK_PRIORITIES } from 'src/lib/tasksPriority';
import { TASK_LIST_ORDERS } from 'src/lib/tasksPullOrder';
import { transitionRequestDigest } from 'src/lib/tasksTransitionIdempotency';
import { captureAuthority } from 'src/lib/workAuthority';

import {
  parseEnumListQuery,
  parseEnumQuery,
  parseNullableEnumListQuery,
  parseNullableToolContextBody,
  parsePagination,
  requestPrincipalFromCtx,
  requireAuth,
  resolveWriteProjectId,
} from './helpers';
import { idempotencyKeyOf } from './idempotencyKey';
import { resolveListScope } from './listScope';
import { authorizeTask, taskPins } from './taskAccess';

const tasksRouter = new Router<Context>();

/**
 * The transition principal for the authenticated caller, in the task engine's
 * own `{ kind, id }` shape.
 *
 * `TaskPrincipal` carries two kinds the auth layer has no notion of
 * (`automation`, `approval`), so the shapes stay distinct — but the *rule* for
 * the two credential-derived kinds is shared with audit and the REST helper, so
 * a key-started background drive is named identically in task history and in the
 * audit log.
 */
const principalFromCtx = (ctx: Context): TaskPrincipal => {
  const { principalType, principalId } = requestPrincipalFromCtx(ctx);
  return {
    kind: principalType,
    id: principalId,
    actsFor: actsForOf(ctx.authUser!),
  };
};

const blockedQuery = (ctx: Context): boolean | undefined => {
  const value = parseEnumQuery({
    ctx,
    name: 'blocked',
    allowed: ['true', 'false'],
  });
  return value === undefined ? undefined : value === 'true';
};

/** The filters `GET /tasks` and `GET /tasks/graph` share, read off the query. */
const listFiltersQuery = async (ctx: Context) => {
  requireAuth(ctx);
  const metadata = readStructuredQuery({ name: 'metadata', query: ctx.query });
  const { projectIds } = await resolveListScope({
    ctx,
    action: 'tasks:ListTasks',
    resourceType: 'task',
    projectSelector: 'optional',
  });
  return {
    projectIds,
    workflowId: taskPins.read(ctx, 'workflow_id'),
    state: ctx.query.state as string | undefined,
    statuses: parseEnumListQuery({
      ctx,
      name: 'status',
      allowed: ['open', 'closed'],
    }),
    automationStatuses: parseNullableEnumListQuery({
      ctx,
      name: 'automation_status',
      allowed: TASK_AUTOMATION_STATUSES,
    }),
    priorities: parseNullableEnumListQuery({
      ctx,
      name: 'priority',
      allowed: TASK_PRIORITIES,
    }),
    assignee: ctx.query.assignee as string | undefined,
    blocked: blockedQuery(ctx),
    upstreamOf: ctx.query.upstream_of as string | undefined,
    metadata,
  };
};

/**
 * @openapi
 * Managed via packages/server/src/rest/openapi/v1/tasks.yaml
 */
tasksRouter.get('/tasks', async (ctx: Context) => {
  ctx.body = await listTasks({
    ...(await listFiltersQuery(ctx)),
    order: parseEnumQuery({ ctx, name: 'order', allowed: TASK_LIST_ORDERS }),
    ...parsePagination(ctx),
  });
});

/**
 * @openapi
 * Managed via packages/server/src/rest/openapi/v1/tasks.yaml
 */
tasksRouter.get('/tasks/graph', async (ctx: Context) => {
  ctx.body = await getTaskGraph(await listFiltersQuery(ctx));
});

tasksRouter.get('/tasks/:task_id', async (ctx: Context) => {
  ctx.body = await authorizeTask({
    ctx,
    action: 'tasks:GetTask',
    id: ctx.params.task_id,
  });
});

tasksRouter.get('/tasks/:task_id/history', async (ctx: Context) => {
  await authorizeTask({
    ctx,
    action: 'tasks:GetTask',
    id: ctx.params.task_id,
  });

  ctx.body = await getTaskHistory({
    id: ctx.params.task_id,
    ...parsePagination(ctx),
  });
});

tasksRouter.get('/tasks/:task_id/transitions', async (ctx: Context) => {
  await authorizeTask({
    ctx,
    action: 'tasks:GetTask',
    id: ctx.params.task_id,
  });

  ctx.body = await listTaskTransitions({
    id: ctx.params.task_id,
    principal: principalFromCtx(ctx),
    ...parsePagination(ctx),
  });
});

tasksRouter.post('/tasks', async (ctx: Context) => {
  requireAuth(ctx);
  const body = ctx.request.body as {
    project_id?: string;
    workflow_id: string;
    title: string;
    payload?: Record<string, unknown> | null;
    assignee?: string | null;
    state?: string | null;
    tool_context?: unknown;
    metadata?: unknown;
  };

  const projectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.project_id,
    action: 'tasks:CreateTask',
    resourceType: 'task',
  });
  const request = {
    workflowId: body.workflow_id,
    title: body.title,
    payload: body.payload,
    assignee: body.assignee,
    state: body.state,
    toolContext: parseNullableToolContextBody({
      raw: body.tool_context,
      reservedPrefix: 'refuse',
    }),
    // Rejected before the task row exists, like every other metadata bag.
    metadata: parseMetadataBag(body.metadata),
  };
  const idempotencyKey = idempotencyKeyOf(ctx);
  const { idempotent, ...task } = await createTask({
    projectId,
    ...request,
    idempotency: idempotencyKey
      ? { key: idempotencyKey, digest: createTaskRequestDigest(request) }
      : undefined,
    principal: principalFromCtx(ctx),
    authority: captureAuthority({ authUser: ctx.authUser }),
  });

  ctx.status = idempotent ? 200 : 201;
  ctx.body = task;
});

tasksRouter.patch('/tasks/:task_id', async (ctx: Context) => {
  await authorizeTask({
    ctx,
    action: 'tasks:UpdateTask',
    id: ctx.params.task_id,
  });

  const body = ctx.request.body as {
    title?: string;
    payload?: Record<string, unknown>;
    assignee?: string | null;
    metadata?: unknown;
  };

  ctx.body = await updateTask({
    id: ctx.params.task_id,
    title: body.title,
    payload: body.payload,
    assignee: body.assignee,
    metadata: readNullableMetadataBag(body.metadata),
  });
});

tasksRouter.post('/tasks/:task_id/transitions', async (ctx: Context) => {
  await authorizeTask({
    ctx,
    action: 'tasks:TransitionTask',
    id: ctx.params.task_id,
  });

  const body = ctx.request.body as {
    transition: string;
    note?: string | null;
    tool_context?: unknown;
    payload?: Record<string, unknown>;
  };
  const toolContext = parseNullableToolContextBody({
    raw: body.tool_context,
    reservedPrefix: 'refuse',
  });
  const idempotencyKey = idempotencyKeyOf(ctx);

  ctx.body = await transitionTask({
    id: ctx.params.task_id,
    transition: body.transition,
    note: body.note,
    // Passed straight through, `undefined` included: omitting the field keeps
    // the task's stored bag, which is not the same as sending `{}`.
    toolContext,
    idempotency: idempotencyKey
      ? {
          key: idempotencyKey,
          digest: transitionRequestDigest({
            transition: body.transition,
            note: body.note,
            toolContext,
            payload: body.payload,
          }),
        }
      : undefined,
    payload: body.payload,
    principal: principalFromCtx(ctx),
    authority: captureAuthority({ authUser: ctx.authUser }),
    // Stored work names a user or key like any other caller, so the principal
    // above cannot tell a dispatch continuing its own chain from the person
    // who started it. This can.
    viaWork: ctx.authUser!.work !== undefined,
  });
});

tasksRouter.post('/tasks/:task_id/migrate', async (ctx: Context) => {
  await authorizeTask({
    ctx,
    action: 'tasks:MigrateTask',
    id: ctx.params.task_id,
  });

  const body = ctx.request.body as {
    to_version: number;
    state_map?: Record<string, string>;
  };

  ctx.body = await migrateTask({
    id: ctx.params.task_id,
    toVersion: body.to_version,
    stateMap: body.state_map,
    principal: principalFromCtx(ctx),
  });
});

tasksRouter.post('/tasks/:task_id/pause', async (ctx: Context) => {
  await authorizeTask({
    ctx,
    action: 'tasks:PauseTask',
    id: ctx.params.task_id,
  });

  const body = ctx.request.body as { reason?: unknown };

  ctx.body = await pauseTask({
    id: ctx.params.task_id,
    reason: typeof body.reason === 'string' ? body.reason : null,
    origin: 'operator',
  });
});

tasksRouter.post('/tasks/:task_id/resume', async (ctx: Context) => {
  await authorizeTask({
    ctx,
    action: 'tasks:ResumeTask',
    id: ctx.params.task_id,
  });

  ctx.body = await resumeTask({
    id: ctx.params.task_id,
    // The suppressed dispatch runs as whoever resumed: the resume is the
    // decision to spend, and the move that scheduled the work may be weeks old.
    authority: captureAuthority({ authUser: ctx.authUser }),
  });
});

tasksRouter.delete('/tasks/:task_id', async (ctx: Context) => {
  await authorizeTask({
    ctx,
    action: 'tasks:DeleteTask',
    id: ctx.params.task_id,
  });

  await deleteTask({ id: ctx.params.task_id });
  ctx.status = 204;
});

export { principalFromCtx, tasksRouter };
