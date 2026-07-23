import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import {
  acknowledgeException,
  getException,
  listExceptions,
  resolveException,
} from 'src/lib/exceptions';
import { buildSrn } from 'src/lib/iam';

import { parsePagination } from './helpers';

const exceptionsRouter = new Router<Context>();

// Item-level SRN so a project-scoped principal (whose policy grants an SRN
// pattern, never the bare `*`) is authorized on get/acknowledge/resolve — see
// the equivalent note in approvals.ts.
const exceptionSrn = (exception: {
  projectId?: string;
  id: string;
}): string => {
  return buildSrn({
    projectPublicId: exception.projectId!,
    resourceType: 'exception',
    resourceId: exception.id,
  });
};

exceptionsRouter.get('/exceptions', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectPublicId = ctx.query.projectId as string | undefined;

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action: 'exceptions:ListExceptions',
    resourceType: 'exception',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = await listExceptions({
    projectIds: projectIds ?? [],
    status: ctx.query.status as string | undefined,
    severity: ctx.query.severity as string | undefined,
    kind: ctx.query.kind as string | undefined,
    ...parsePagination(ctx),
  });
});

exceptionsRouter.get('/exceptions/:exception_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const exception = await getException({ id: ctx.params.exception_id });

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: exception.projectId!,
    action: 'exceptions:GetException',
    resource: exceptionSrn(exception),
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = exception;
});

exceptionsRouter.post(
  '/exceptions/:exception_id/acknowledge',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const exception = await getException({ id: ctx.params.exception_id });

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: exception.projectId!,
      action: 'exceptions:AcknowledgeException',
      resource: exceptionSrn(exception),
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    ctx.body = await acknowledgeException({
      id: ctx.params.exception_id,
      userId: ctx.authUser.id,
    });
  }
);

exceptionsRouter.post(
  '/exceptions/:exception_id/resolve',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const exception = await getException({ id: ctx.params.exception_id });

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: exception.projectId!,
      action: 'exceptions:ResolveException',
      resource: exceptionSrn(exception),
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const body = (ctx.request.body ?? {}) as { note?: string };

    ctx.body = await resolveException({
      id: ctx.params.exception_id,
      userId: ctx.authUser.id,
      note: body.note ?? null,
    });
  }
);

export { exceptionsRouter };
