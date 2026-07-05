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

import { checkAuth, resolveWriteProjectId } from './helpers';

const discussionsRouter = new Router<Context>();

type CreateDiscussionBody = {
  projectId?: string;
  name: string;
  aiProviderId: string;
  description?: string | null;
  maxRounds?: number | null;
  model?: string | null;
  synthesis?: SynthesisConfig | null;
  tags?: Record<string, string> | null;
  participants?: ParticipantInput[];
};

type UpdateDiscussionBody = {
  name?: string;
  description?: string | null;
  maxRounds?: number | null;
  aiProviderId?: string;
  model?: string | null;
  synthesis?: SynthesisConfig | null;
  tags?: Record<string, string> | null;
  participants?: ParticipantInput[];
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

  const projectPublicId = ctx.query.projectId as string | undefined;
  const { limit, offset } = parsePage(ctx);

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action: 'discussions:ListDiscussions',
  });
  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

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
    projectPublicId: body.projectId,
    action: 'discussions:CreateDiscussion',
  });
  if (targetProjectId === null) return;

  const discussion = await createDiscussion({
    projectId: Number(targetProjectId),
    name: body.name,
    aiProviderId: body.aiProviderId,
    description: body.description,
    maxRounds: body.maxRounds,
    model: body.model,
    synthesis: body.synthesis,
    tags: body.tags,
    participants: body.participants,
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
    projectPublicId: run.projectId!,
    action: 'discussions:GetDiscussionRun',
    resource: buildSrn({
      projectPublicId: run.projectId!,
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
    projectPublicId: discussion.projectId!,
    action: 'discussions:GetDiscussion',
    resource: buildSrn({
      projectPublicId: discussion.projectId!,
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
    projectPublicId: discussion.projectId!,
    action: 'discussions:UpdateDiscussion',
    resource: buildSrn({
      projectPublicId: discussion.projectId!,
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
    maxRounds: body.maxRounds,
    aiProviderId: body.aiProviderId,
    model: body.model,
    synthesis: body.synthesis,
    tags: body.tags,
    participants: body.participants,
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
      projectPublicId: discussion.projectId!,
      action: 'discussions:DeleteDiscussion',
      resource: buildSrn({
        projectPublicId: discussion.projectId!,
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
      projectPublicId: discussion.projectId!,
      action: 'discussions:CreateDiscussionRun',
      resource: buildSrn({
        projectPublicId: discussion.projectId!,
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

    const run = await runDiscussion({
      discussionId: ctx.params.discussion_id,
      topic: body.topic,
      startedBy: {
        userId: ctx.authUser.publicId,
        username: ctx.authUser.username,
      },
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
      projectPublicId: discussion.projectId!,
      action: 'discussions:ListDiscussionRuns',
      resource: buildSrn({
        projectPublicId: discussion.projectId!,
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
