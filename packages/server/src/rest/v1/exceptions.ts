import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import {
  acknowledgeException,
  EXCEPTION_STATUSES,
  getException,
  listExceptions,
  resolveException,
} from 'src/lib/exceptions';
import { buildSrn } from 'src/lib/iam';

import type { ProjectOwned } from './helpers';
import {
  parseEnumListQuery,
  parsePagination,
  requestPrincipalFromCtx,
  requireAuth,
  resolveReadProjectIds,
} from './helpers';
import { resourceRefusal } from './resourceAccess';

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
    statuses: parseEnumListQuery({
      ctx,
      name: 'status',
      allowed: EXCEPTION_STATUSES,
    }),
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
    throw await resourceRefusal({
      ctx,
      projectPublicId: exception.project_id!,
      notFound: new DomainError(
        'EXCEPTION_NOT_FOUND',
        `Exception '${ctx.params.exception_id}' not found.`
      ),
    });
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
      throw await resourceRefusal({
        ctx,
        projectPublicId: exception.project_id!,
        notFound: new DomainError(
          'EXCEPTION_NOT_FOUND',
          `Exception '${ctx.params.exception_id}' not found.`
        ),
      });
    }

    ctx.body = await acknowledgeException({
      id: ctx.params.exception_id,
      acknowledgedBy: requestPrincipalFromCtx(ctx),
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
      throw await resourceRefusal({
        ctx,
        projectPublicId: exception.project_id!,
        notFound: new DomainError(
          'EXCEPTION_NOT_FOUND',
          `Exception '${ctx.params.exception_id}' not found.`
        ),
      });
    }

    const body = ctx.request.body as { note?: string };

    ctx.body = await resolveException({
      id: ctx.params.exception_id,
      resolvedBy: requestPrincipalFromCtx(ctx),
      note: body.note ?? null,
    });
  }
);

export { exceptionsRouter };
