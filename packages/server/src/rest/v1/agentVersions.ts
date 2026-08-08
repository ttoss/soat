import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import {
  abortAgentRelease,
  getAgentVersion,
  listAgentVersions,
  promoteAgentRelease,
  restoreAgentVersion,
  setAgentRelease,
} from 'src/lib/agentVersions';

import { parsePagination, resolveReadProjectIds } from './helpers';

/**
 * Agent version history and staged rollout (docs/prd-agent-versions.md).
 *
 * Versions are never written through this router: they are archived by the
 * shared agent write path, so this surface is read-only apart from `restore`,
 * `release`, `promote` and `abort` — each of which expresses itself as an
 * ordinary agent update carrying an archived config.
 */
export const agentVersionsRouter = new Router<Context>();

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
 * @openapi
 * /api/v1/agents/{agent_id}/versions:
 *   get:
 *     $ref: 'openapi/v1/agents.yaml#/paths/~1api~1v1~1agents~1{agent_id}~1versions/get'
 */
agentVersionsRouter.get('/agents/:agent_id/versions', async (ctx: Context) => {
  const projectIds = await resolveReadProjectIds({
    ctx,
    action: 'agents:ListAgentVersions',
    resourceType: 'agent',
  });
  ctx.body = await listAgentVersions({
    projectIds,
    agentId: ctx.params.agent_id,
    ...parsePagination(ctx),
  });
});

/**
 * @openapi
 * /api/v1/agents/{agent_id}/versions/{version}:
 *   get:
 *     $ref: 'openapi/v1/agents.yaml#/paths/~1api~1v1~1agents~1{agent_id}~1versions~1{version}/get'
 */
agentVersionsRouter.get(
  '/agents/:agent_id/versions/:version',
  async (ctx: Context) => {
    const projectIds = await resolveReadProjectIds({
      ctx,
      action: 'agents:GetAgentVersion',
      resourceType: 'agent',
    });
    ctx.body = await getAgentVersion({
      projectIds,
      agentId: ctx.params.agent_id,
      version: parseVersionParam(ctx.params.version),
    });
  }
);

/**
 * @openapi
 * /api/v1/agents/{agent_id}/versions/{version}/restore:
 *   post:
 *     $ref: 'openapi/v1/agents.yaml#/paths/~1api~1v1~1agents~1{agent_id}~1versions~1{version}~1restore/post'
 */
agentVersionsRouter.post(
  '/agents/:agent_id/versions/:version/restore',
  async (ctx: Context) => {
    const projectIds = await resolveReadProjectIds({
      ctx,
      action: 'agents:RestoreAgentVersion',
      resourceType: 'agent',
    });
    const body = ctx.request.body as { label?: unknown };

    ctx.body = await restoreAgentVersion({
      projectIds,
      agentId: ctx.params.agent_id,
      version: parseVersionParam(ctx.params.version),
      label: typeof body.label === 'string' ? body.label : undefined,
      createdByUserId: ctx.authUser?.id,
    });
  }
);

/**
 * @openapi
 * /api/v1/agents/{agent_id}/release:
 *   put:
 *     $ref: 'openapi/v1/agents.yaml#/paths/~1api~1v1~1agents~1{agent_id}~1release/put'
 */
agentVersionsRouter.put('/agents/:agent_id/release', async (ctx: Context) => {
  const projectIds = await resolveReadProjectIds({
    ctx,
    action: 'agents:SetAgentRelease',
    resourceType: 'agent',
  });
  const body = ctx.request.body as {
    stable_version?: unknown;
    canary_version?: unknown;
    canary_percent?: unknown;
  };

  // Shape validation lives in the lib so the rule has one home; the handler
  // only names the wire fields.
  ctx.body = await setAgentRelease({
    projectIds,
    agentId: ctx.params.agent_id,
    stableVersion: body.stable_version,
    canaryVersion: body.canary_version,
    canaryPercent: body.canary_percent,
  });
});

/**
 * @openapi
 * /api/v1/agents/{agent_id}/release/promote:
 *   post:
 *     $ref: 'openapi/v1/agents.yaml#/paths/~1api~1v1~1agents~1{agent_id}~1release~1promote/post'
 */
agentVersionsRouter.post(
  '/agents/:agent_id/release/promote',
  async (ctx: Context) => {
    const projectIds = await resolveReadProjectIds({
      ctx,
      action: 'agents:SetAgentRelease',
      resourceType: 'agent',
    });
    ctx.body = await promoteAgentRelease({
      projectIds,
      agentId: ctx.params.agent_id,
      createdByUserId: ctx.authUser?.id,
    });
  }
);

/**
 * @openapi
 * /api/v1/agents/{agent_id}/release/abort:
 *   post:
 *     $ref: 'openapi/v1/agents.yaml#/paths/~1api~1v1~1agents~1{agent_id}~1release~1abort/post'
 */
agentVersionsRouter.post(
  '/agents/:agent_id/release/abort',
  async (ctx: Context) => {
    const projectIds = await resolveReadProjectIds({
      ctx,
      action: 'agents:SetAgentRelease',
      resourceType: 'agent',
    });
    ctx.body = await abortAgentRelease({
      projectIds,
      agentId: ctx.params.agent_id,
      createdByUserId: ctx.authUser?.id,
    });
  }
);
