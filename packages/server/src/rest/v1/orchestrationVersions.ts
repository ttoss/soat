import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import {
  getOrchestrationVersion,
  listOrchestrationVersions,
  restoreOrchestrationVersion,
} from 'src/lib/orchestrationVersions';

import { parsePagination } from './helpers';

/**
 * Orchestration graph version history (issue #872).
 *
 * Versions are never written through this router: they are archived by the
 * shared orchestration write path, so this surface is read-only apart from
 * `restore`, which expresses itself as an ordinary orchestration update carrying
 * an archived graph.
 *
 * A separate router, mounted onto `orchestrationsRouter`, mirroring how
 * `agentVersions.ts` hangs off the agents router.
 */
export const orchestrationVersionsRouter = new Router<Context>();

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

const checkOrchestrationAccess = async (
  ctx: Context,
  action: string
): Promise<number[] | undefined | null> => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return null;
  }
  const projectIds = await ctx.authUser.resolveProjectIds({
    action,
    resourceType: 'orchestration',
  });
  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return null;
  }
  return projectIds ?? undefined;
};

/**
 * @openapi
 * /api/v1/orchestrations/{orchestration_id}/versions:
 *   get:
 *     $ref: 'openapi/v1/orchestrations.yaml#/paths/~1api~1v1~1orchestrations~1{orchestration_id}~1versions/get'
 */
orchestrationVersionsRouter.get(
  '/orchestrations/:orchestration_id/versions',
  async (ctx: Context) => {
    const projectIds = await checkOrchestrationAccess(
      ctx,
      'orchestrations:ListOrchestrationVersions'
    );
    if (projectIds === null) return;

    ctx.body = await listOrchestrationVersions({
      projectIds,
      orchestrationId: ctx.params['orchestration_id'] as string,
      ...parsePagination(ctx),
    });
  }
);

/**
 * @openapi
 * /api/v1/orchestrations/{orchestration_id}/versions/{version}:
 *   get:
 *     $ref: 'openapi/v1/orchestrations.yaml#/paths/~1api~1v1~1orchestrations~1{orchestration_id}~1versions~1{version}/get'
 */
orchestrationVersionsRouter.get(
  '/orchestrations/:orchestration_id/versions/:version',
  async (ctx: Context) => {
    const projectIds = await checkOrchestrationAccess(
      ctx,
      'orchestrations:GetOrchestrationVersion'
    );
    if (projectIds === null) return;

    ctx.body = await getOrchestrationVersion({
      projectIds,
      orchestrationId: ctx.params['orchestration_id'] as string,
      version: parseVersionParam(ctx.params['version'] as string),
    });
  }
);

/**
 * @openapi
 * /api/v1/orchestrations/{orchestration_id}/versions/{version}/restore:
 *   post:
 *     $ref: 'openapi/v1/orchestrations.yaml#/paths/~1api~1v1~1orchestrations~1{orchestration_id}~1versions~1{version}~1restore/post'
 */
orchestrationVersionsRouter.post(
  '/orchestrations/:orchestration_id/versions/:version/restore',
  async (ctx: Context) => {
    const projectIds = await checkOrchestrationAccess(
      ctx,
      'orchestrations:RestoreOrchestrationVersion'
    );
    if (projectIds === null) return;

    const body = (ctx.request.body ?? {}) as { label?: unknown };

    ctx.body = await restoreOrchestrationVersion({
      projectIds,
      orchestrationId: ctx.params['orchestration_id'] as string,
      version: parseVersionParam(ctx.params['version'] as string),
      label: typeof body.label === 'string' ? body.label : undefined,
      createdByUserId: ctx.authUser?.id,
    });
  }
);
