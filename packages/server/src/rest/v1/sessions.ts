import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import { agents } from 'src/lib/agentAccessor';
import { buildSrn } from 'src/lib/iam';
import { compilePolicy } from 'src/lib/policyCompiler';
import {
  createSession,
  deleteSession,
  findSessionAccess,
  getSession,
  listSessions,
  updateSession,
} from 'src/lib/sessions';
import {
  assertNoSystemTagKeys,
  buildResourceTagContext,
  readTagBag,
  readTagQuery,
} from 'src/lib/tags';
import { setAuditResourceHint } from 'src/middleware/audit';

import { parsePagination, requireAuth, requireProjectAccess } from './helpers';
import { sessionSubResourcesRouter } from './sessionSubResources';
import { authorizeSharedUse } from './sharedAccess';

export const sessionsRouter = new Router<Context>();

/**
 * Resolves a session by its (globally unique) id and authorizes the action
 * against the session's own SRN, carrying its tags as evaluation context.
 *
 * The session is loaded *before* the policy is evaluated, which is what makes
 * `soat:ResourceTag/<key>` work: a conditioned statement can only match once
 * the tags it names are known. A project-level probe for
 * `srn:<project>:session:*` carries no context, so no conditioned statement
 * would match and the resource segment of a policy would never be compared at
 * all — tag-based access control advertised and not enforced.
 *
 * Throws `DomainError` with codes:
 *  - `UNAUTHORIZED`       – no authenticated user
 *  - `FORBIDDEN`          – no policy allows the action on this session
 *  - `RESOURCE_NOT_FOUND` – session does not exist
 */
export const checkSessionAccess = async (
  ctx: Context,
  action: string
): Promise<{
  agentId: number;
  agentPublicId: string;
  projectId: number;
  projectPublicId: string;
  tags: Record<string, string> | null;
}> => {
  requireAuth(ctx);

  const access = await findSessionAccess({ sessionId: ctx.params.session_id });
  if (!access) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Session not found');
  }

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: access.projectPublicId,
    action,
    resource: buildSrn({
      projectPublicId: access.projectPublicId,
      resourceType: 'session',
      resourceId: ctx.params.session_id,
    }),
    context: buildResourceTagContext({
      resourceType: 'session',
      tags: access.tags,
    }),
  });
  if (!allowed) {
    throw new DomainError('FORBIDDEN', 'Forbidden');
  }

  return access;
};

// ── Create Session ───────────────────────────────────────────────────────

/**
 * The caller's own agent a session opens on. Searched inside the caller's
 * projects only, so an agent elsewhere answers exactly as an id that names
 * nothing.
 */
const resolveOwnAgentTarget = async (args: {
  ctx: Context;
  agentId: string;
}): Promise<{ projectId: number; agentId: number }> => {
  const projectIds = await requireProjectAccess({
    ctx: args.ctx,
    action: 'agents:CreateSession',
    resourceType: 'session',
  });
  const agent = await agents.getByPublicId({ id: args.agentId, projectIds });
  return { projectId: agent.projectId, agentId: agent.id as number };
};

sessionsRouter.post('/sessions', async (ctx: Context) => {
  requireAuth(ctx);

  const body = ctx.request.body as {
    agent_id?: string;
    name?: string;
    tags?: unknown;
    actor_id?: string;
    auto_generate?: boolean;
    tool_context?: Record<string, string> | null;
    inactivity_ttl_seconds?: number;
    message_delay_seconds?: number | null;
  };

  // A credential confined to a grantee project opens the session there, on an
  // agent shared with it.
  const shared = await authorizeSharedUse({
    ctx,
    resourceType: 'agent',
    resourceId: String(body.agent_id),
    action: 'agents:CreateSession',
  });
  const target = shared
    ? { projectId: shared.projectId, agentId: shared.resourceDbId }
    : await resolveOwnAgentTarget({ ctx, agentId: String(body.agent_id) });

  const result = await createSession({
    projectId: target.projectId,
    agentId: target.agentId,
    name: body.name,
    tags: assertNoSystemTagKeys(readTagBag(body.tags)),
    actorId: body.actor_id,
    autoGenerate: body.auto_generate,
    toolContext: body.tool_context,
    inactivityTtlSeconds: body.inactivity_ttl_seconds,
    messageDelaySeconds: body.message_delay_seconds,
  });

  ctx.status = 201;
  ctx.body = result;
});

// ── List Sessions ────────────────────────────────────────────────────────

sessionsRouter.get('/sessions', async (ctx: Context) => {
  requireAuth(ctx);

  const {
    project_id: projectPublicId,
    agent_id: agentId,
    actor_id: actorId,
    status,
  } = ctx.query as Record<string, string | undefined>;
  const tags = readTagQuery(ctx.query.tags);

  const projectIds = await requireProjectAccess({
    ctx,
    projectPublicId,
    action: 'agents:ListSessions',
    resourceType: 'session',
  });

  // A list authorizes before it has rows, so the policy is compiled into the
  // query instead: `soat:ResourceTag` conditions become JSONB predicates on the
  // same column `?tags=` reads. One project at a time — a policy is read per
  // project — so an unnarrowed listing stays project-level, as on `GET /actors`.
  let policyWhere: Record<string, unknown> | undefined;
  if (projectPublicId) {
    const compiled = compilePolicy({
      policies: await ctx.authUser.getPolicies(projectPublicId),
      action: 'agents:ListSessions',
      resourceType: 'session',
      projectPublicId,
    });
    if (!compiled.hasAccess) {
      throw new DomainError('FORBIDDEN', 'Forbidden');
    }
    policyWhere = compiled.where;
  }

  ctx.body = await listSessions({
    projectIds,
    agentId,
    actorId,
    status,
    tags,
    policyWhere,
    ...parsePagination(ctx),
  });
});

// ── Get Session ──────────────────────────────────────────────────────────

sessionsRouter.get('/sessions/:session_id', async (ctx: Context) => {
  const { agentId } = await checkSessionAccess(ctx, 'agents:GetSession');

  ctx.body = await getSession({
    agentId,
    sessionId: ctx.params.session_id,
    includeUsage: true,
  });
});

// ── Update Session ───────────────────────────────────────────────────────

sessionsRouter.patch('/sessions/:session_id', async (ctx: Context) => {
  const { agentId } = await checkSessionAccess(ctx, 'agents:UpdateSession');

  const body = ctx.request.body as {
    name?: string | null;
    status?: string;
    auto_generate?: boolean;
    tool_context?: Record<string, string> | null;
    inactivity_ttl_seconds?: number;
    message_delay_seconds?: number | null;
  };

  ctx.body = await updateSession({
    agentId,
    sessionId: ctx.params.session_id,
    name: body.name,
    status: body.status,
    autoGenerate: body.auto_generate,
    toolContext: body.tool_context,
    inactivityTtlSeconds: body.inactivity_ttl_seconds,
    messageDelaySeconds: body.message_delay_seconds,
  });
});

// ── Delete Session ───────────────────────────────────────────────────────

sessionsRouter.delete('/sessions/:session_id', async (ctx: Context) => {
  const { agentId, projectPublicId } = await checkSessionAccess(
    ctx,
    'agents:DeleteSession'
  );

  // The success response is `204 No Content`, so the audit middleware has no
  // body to backfill the project/SRN from — hand it the resolved resource
  // before the delete runs (see `setAuditResourceHint`).
  setAuditResourceHint(ctx, {
    projectPublicId,
    resourceSrn: buildSrn({
      projectPublicId,
      resourceType: 'session',
      resourceId: ctx.params.session_id,
    }),
    resourcePublicId: ctx.params.session_id,
  });

  await deleteSession({
    agentId,
    sessionId: ctx.params.session_id,
  });

  ctx.status = 204;
});

// ── Sub-resources (messages, generate, tool-outputs, tags) ─────────────────

sessionsRouter.use(sessionSubResourcesRouter.routes());
sessionsRouter.use(sessionSubResourcesRouter.allowedMethods());
