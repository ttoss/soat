import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import {
  acknowledgeException,
  getException,
  listExceptions,
  resolveException,
} from 'src/lib/exceptions';
import { buildSrn } from 'src/lib/iam';

import type { ProjectOwned } from './helpers';
import { parsePagination, requireAuth, resolveReadProjectIds } from './helpers';

const exceptionsRouter = new Router<Context>();

// Item-level SRN so a project-scoped principal (whose policy grants an SRN
// pattern, never the bare `*`) is authorized on get/acknowledge/resolve — see
// the equivalent note in approvals.ts.
const exceptionSrn = (exception: { id: string } & ProjectOwned): string => {
  return buildSrn({
    projectPublicId: exception.project_id!,
    resourceType: 'exception',
    resourceId: exception.id,
  });
};

exceptionsRouter.get('/exceptions', async (ctx: Context) => {
  requireAuth(ctx);

  const projectPublicId = ctx.query.project_id as string | undefined;

  const projectIds = await resolveReadProjectIds({
    ctx,
    projectPublicId,
    action: 'exceptions:ListExceptions',
    resourceType: 'exception',
  });

  ctx.body = await listExceptions({
    projectIds: projectIds ?? [],
    status: ctx.query.status as string | undefined,
    severity: ctx.query.severity as string | undefined,
    kind: ctx.query.kind as string | undefined,
    ...parsePagination(ctx),
  });
});

exceptionsRouter.get('/exceptions/:exception_id', async (ctx: Context) => {
  requireAuth(ctx);

  const exception = await getException({ id: ctx.params.exception_id });

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: exception.project_id!,
    action: 'exceptions:GetException',
    resource: exceptionSrn(exception),
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  ctx.body = exception;
});

exceptionsRouter.post(
  '/exceptions/:exception_id/acknowledge',
  async (ctx: Context) => {
    requireAuth(ctx);

    const exception = await getException({ id: ctx.params.exception_id });

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: exception.project_id!,
      action: 'exceptions:AcknowledgeException',
      resource: exceptionSrn(exception),
    });
    if (!allowed) {
      throw new DomainError('FORBIDDEN', 'Forbidden');
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
    requireAuth(ctx);

    const exception = await getException({ id: ctx.params.exception_id });

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: exception.project_id!,
      action: 'exceptions:ResolveException',
      resource: exceptionSrn(exception),
    });
    if (!allowed) {
      throw new DomainError('FORBIDDEN', 'Forbidden');
    }

    const body = ctx.request.body as { note?: string };

    ctx.body = await resolveException({
      id: ctx.params.exception_id,
      userId: ctx.authUser.id,
      note: body.note ?? null,
    });
  }
);

export { exceptionsRouter };
