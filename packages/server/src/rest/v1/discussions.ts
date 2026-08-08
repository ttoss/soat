import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import {
  getDiscussionRun,
  listDiscussionRuns,
  runDiscussion,
} from 'src/lib/discussionRuns';
import {
  createDiscussion,
  deleteDiscussion,
  getDiscussion,
  listDiscussions,
  type ParticipantInput,
  type SynthesisConfig,
  updateDiscussion,
} from 'src/lib/discussions';
import { buildSrn } from 'src/lib/iam';
import { compilePolicy } from 'src/lib/policyCompiler';

import {
  checkAuth,
  requestPrincipalFromCtx,
  resolveProjectIdsWithAction,
  resolveWriteProjectId,
} from './helpers';

const discussionsRouter = new Router<Context>();

// The wire contract (discussions.yaml `SynthesisConfig` / `ParticipantInput`)
// is snake_case, but the lib types (`SynthesisConfig` / `ParticipantInput`
// from `src/lib/discussions.ts`) are camelCase — these two are NOT the same
// shape despite the shared type names. Nothing rewrites keys on the way in
// anymore, so the raw request body fields below are the wire shape.
type WireSynthesisConfig = {
  ai_provider_id?: string;
  model?: string;
  prompt?: string;
  effort?: SynthesisConfig['effort'];
};

type WireParticipantInput = {
  name?: string | null;
  prompt?: string | null;
  position?: number;
  actor_id?: string | null;
  ai_provider_id?: string | null;
  model?: string | null;
  temperature?: number | null;
  effort?: ParticipantInput['effort'];
};

type CreateDiscussionBody = {
  project_id?: string;
  name: string;
  /**
   * Optional since the model-routing project-default amendment: a discussion
   * that pins no provider inherits the project's default_model_route_id.
   */
  ai_provider_id?: string;
  description?: string | null;
  max_rounds?: number | null;
  model?: string | null;
  synthesis?: WireSynthesisConfig | null;
  tags?: Record<string, string> | null;
  participants?: WireParticipantInput[];
};

type UpdateDiscussionBody = {
  name?: string;
  description?: string | null;
  max_rounds?: number | null;
  /** An explicit `null` unpins the discussion onto the project default route. */
  ai_provider_id?: string | null;
  model?: string | null;
  synthesis?: WireSynthesisConfig | null;
  tags?: Record<string, string> | null;
  participants?: WireParticipantInput[];
};

/** Converts the wire (snake_case) synthesis config into the lib's camelCase shape. */
const toSynthesisConfig = (
  synthesis?: WireSynthesisConfig | null
): SynthesisConfig | null | undefined => {
  if (synthesis === undefined) return undefined;
  if (synthesis === null) return null;
  return {
    aiProviderId: synthesis.ai_provider_id,
    model: synthesis.model,
    prompt: synthesis.prompt,
    effort: synthesis.effort,
  };
};

/** Converts wire (snake_case) participant inputs into the lib's camelCase shape. */
const toParticipantInputs = (
  participants?: WireParticipantInput[]
): ParticipantInput[] | undefined => {
  return participants?.map((participant) => {
    return {
      name: participant.name,
      prompt: participant.prompt,
      position: participant.position,
      actorId: participant.actor_id,
      aiProviderId: participant.ai_provider_id,
      model: participant.model,
      temperature: participant.temperature,
      effort: participant.effort,
    };
  });
};

const parsePage = (ctx: Context) => {
  return {
    limit: ctx.query.limit
      ? parseInt(ctx.query.limit as string, 10)
      : undefined,
    offset: ctx.query.offset
      ? parseInt(ctx.query.offset as string, 10)
      : undefined,
  };
};

/** Builds the IAM resource context (tags) for a discussion permission check. */
const discussionContext = (tags?: Record<string, string>) => {
  const context: Record<string, string> = { 'soat:ResourceType': 'discussion' };
  if (tags) {
    for (const [k, v] of Object.entries(tags)) {
      context[`soat:ResourceTag/${k}`] = v;
    }
  }
  return context;
};

discussionsRouter.get('/discussions', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectPublicId = ctx.query.project_id as string | undefined;
  const { limit, offset } = parsePage(ctx);

  const projectIds = await resolveProjectIdsWithAction({
    ctx,
    projectPublicId,
    action: 'discussions:ListDiscussions',
    resourceType: 'discussion',
  });
  if (projectIds === null) return;

  let policyWhere: Record<string, unknown> | undefined;
  if (projectPublicId) {
    const policies = await ctx.authUser.getPolicies(projectPublicId);
    const compiled = compilePolicy({
      policies,
      action: 'discussions:ListDiscussions',
      resourceType: 'discussion',
      projectPublicId,
    });
    if (!compiled.hasAccess) {
      ctx.body = {
        data: [],
        total: 0,
        limit: limit ?? 50,
        offset: offset ?? 0,
      };
      return;
    }
    policyWhere = compiled.where;
  }

  ctx.body = await listDiscussions({ projectIds, policyWhere, limit, offset });
});

discussionsRouter.post('/discussions', async (ctx: Context) => {
  if (!checkAuth(ctx)) return;

  const body = ctx.request.body as CreateDiscussionBody;

  const targetProjectId = await resolveWriteProjectId({
    ctx,
    projectPublicId: body.project_id,
    action: 'discussions:CreateDiscussion',
    resourceType: 'discussion',
  });
  if (targetProjectId === null) return;

  const discussion = await createDiscussion({
    projectId: Number(targetProjectId),
    name: body.name,
    aiProviderId: body.ai_provider_id,
    description: body.description,
    maxRounds: body.max_rounds,
    model: body.model,
    synthesis: toSynthesisConfig(body.synthesis),
    tags: body.tags,
    participants: toParticipantInputs(body.participants),
  });

  ctx.status = 201;
  ctx.body = discussion;
});

// Registered before `/discussions/:discussion_id` — distinct segment count, but
// keep run-scoped reads grouped here.
discussionsRouter.get('/discussions/runs/:run_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const run = await getDiscussionRun({ id: ctx.params.run_id });
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: run.project_id!,
    action: 'discussions:GetDiscussionRun',
    resource: buildSrn({
      projectPublicId: run.project_id!,
      resourceType: 'discussion',
      resourceId: run.id,
    }),
    context: discussionContext(),
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = run;
});

discussionsRouter.get('/discussions/:discussion_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const discussion = await getDiscussion({ id: ctx.params.discussion_id });
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: discussion.project_id!,
    action: 'discussions:GetDiscussion',
    resource: buildSrn({
      projectPublicId: discussion.project_id!,
      resourceType: 'discussion',
      resourceId: discussion.id,
    }),
    context: discussionContext(discussion.tags),
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = discussion;
});

discussionsRouter.patch('/discussions/:discussion_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const discussion = await getDiscussion({ id: ctx.params.discussion_id });
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: discussion.project_id!,
    action: 'discussions:UpdateDiscussion',
    resource: buildSrn({
      projectPublicId: discussion.project_id!,
      resourceType: 'discussion',
      resourceId: discussion.id,
    }),
    context: discussionContext(discussion.tags),
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const body = ctx.request.body as UpdateDiscussionBody;
  ctx.body = await updateDiscussion({
    id: ctx.params.discussion_id,
    name: body.name,
    description: body.description,
    maxRounds: body.max_rounds,
    aiProviderId: body.ai_provider_id,
    model: body.model,
    synthesis: toSynthesisConfig(body.synthesis),
    tags: body.tags,
    participants: toParticipantInputs(body.participants),
  });
});

discussionsRouter.delete(
  '/discussions/:discussion_id',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const discussion = await getDiscussion({ id: ctx.params.discussion_id });
    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: discussion.project_id!,
      action: 'discussions:DeleteDiscussion',
      resource: buildSrn({
        projectPublicId: discussion.project_id!,
        resourceType: 'discussion',
        resourceId: discussion.id,
      }),
      context: discussionContext(discussion.tags),
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    await deleteDiscussion({ id: ctx.params.discussion_id });
    ctx.status = 204;
  }
);

discussionsRouter.post(
  '/discussions/:discussion_id/runs',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const discussion = await getDiscussion({ id: ctx.params.discussion_id });
    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: discussion.project_id!,
      action: 'discussions:CreateDiscussionRun',
      resource: buildSrn({
        projectPublicId: discussion.project_id!,
        resourceType: 'discussion',
        resourceId: discussion.id,
      }),
      context: discussionContext(discussion.tags),
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const body = ctx.request.body as { topic?: string };
    if (!body.topic || typeof body.topic !== 'string') {
      ctx.status = 400;
      ctx.body = { error: 'topic is required' };
      return;
    }

    const principal = requestPrincipalFromCtx(ctx);

    const run = await runDiscussion({
      discussionId: ctx.params.discussion_id,
      topic: body.topic,
      startedByPrincipalType: principal.principalType,
      startedByPrincipalId: principal.principalId,
    });

    ctx.status = 201;
    ctx.body = run;
  }
);

discussionsRouter.get(
  '/discussions/:discussion_id/runs',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const discussion = await getDiscussion({ id: ctx.params.discussion_id });
    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: discussion.project_id!,
      action: 'discussions:ListDiscussionRuns',
      resource: buildSrn({
        projectPublicId: discussion.project_id!,
        resourceType: 'discussion',
        resourceId: discussion.id,
      }),
      context: discussionContext(discussion.tags),
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const { limit, offset } = parsePage(ctx);
    ctx.body = await listDiscussionRuns({
      discussionId: ctx.params.discussion_id,
      limit,
      offset,
    });
  }
);

export { discussionsRouter };
