import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import {
  createAgentFormation,
  deleteAgentFormation,
  type FormationTemplate,
  getAgentFormation,
  listAgentFormationEvents,
  listAgentFormations,
  parseFormationTemplateInput,
  planAgentFormation,
  updateAgentFormation,
  validateFormationTemplate,
} from 'src/lib/agentFormations';

export const agentFormationsRouter = new Router<Context>();

const resolveProjectPublicId = (
  body: { projectId?: string },
  apiKeyProjectPublicId: string | null | undefined
): string | null => {
  if (body.projectId) {
    return body.projectId;
  }
  if (apiKeyProjectPublicId) {
    return apiKeyProjectPublicId;
  }
  return null;
};

agentFormationsRouter.post(
  '/agent-formations/validate',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const body = ctx.request.body as { template?: unknown };
    const parsedTemplate = parseFormationTemplateInput(body.template);
    ctx.body = validateFormationTemplate(parsedTemplate);
  }
);

agentFormationsRouter.post('/agent-formations/plan', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const body = ctx.request.body as {
    projectId?: string;
    formationId?: string;
    template?: unknown;
  };

  const resolvedProjectPublicId = resolveProjectPublicId(
    body,
    ctx.authUser.apiKeyProjectPublicId
  );
  if (!resolvedProjectPublicId) {
    ctx.status = 400;
    ctx.body = { error: 'project_id is required' };
    return;
  }

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: resolvedProjectPublicId,
    action: 'agent-formations:PlanAgentFormation',
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const parsedTemplate = parseFormationTemplateInput(body.template);
  const validation = validateFormationTemplate(parsedTemplate);
  if (!validation.valid) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid template', details: validation.errors };
    return;
  }

  const project = await db.Project.findOne({
    where: { publicId: resolvedProjectPublicId },
  });
  if (!project) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid project ID' };
    return;
  }

  ctx.body = await planAgentFormation({
    projectId: project.id,
    template: parsedTemplate as FormationTemplate,
    formationId: body.formationId,
  });
});

agentFormationsRouter.post('/agent-formations', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const body = ctx.request.body as {
    projectId?: string;
    name?: string;
    template?: unknown;
    metadata?: Record<string, unknown>;
  };

  if (!body.name) {
    ctx.status = 400;
    ctx.body = { error: 'name is required' };
    return;
  }

  const resolvedProjectPublicId = resolveProjectPublicId(
    body,
    ctx.authUser.apiKeyProjectPublicId
  );
  if (!resolvedProjectPublicId) {
    ctx.status = 400;
    ctx.body = { error: 'project_id is required' };
    return;
  }

  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: resolvedProjectPublicId,
    action: 'agent-formations:CreateAgentFormation',
  });
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const parsedTemplate = parseFormationTemplateInput(body.template);
  const validation = validateFormationTemplate(parsedTemplate);
  if (!validation.valid) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid template', details: validation.errors };
    return;
  }

  const project = await db.Project.findOne({
    where: { publicId: resolvedProjectPublicId },
  });
  if (!project) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid project ID' };
    return;
  }

  const result = await createAgentFormation({
    projectId: project.id,
    name: body.name,
    template: parsedTemplate as FormationTemplate,
    metadata: body.metadata,
  });

  if (result === 'name_conflict') {
    ctx.status = 409;
    ctx.body = {
      error: 'A formation with this name already exists in the project',
    };
    return;
  }

  ctx.status = 201;
  ctx.body = result;
});

agentFormationsRouter.get('/agent-formations', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projectPublicId = ctx.query.projectId as string | undefined;

  const projectIds = await ctx.authUser.resolveProjectIds({
    projectPublicId,
    action: 'agent-formations:ListAgentFormations',
  });

  if (projectIds === null) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = await listAgentFormations({ projectIds: projectIds ?? [] });
});

agentFormationsRouter.get(
  '/agent-formations/:formation_id',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const formation = await getAgentFormation({ id: ctx.params.formation_id });
    if (!formation) {
      ctx.status = 404;
      ctx.body = { error: 'Agent formation not found' };
      return;
    }

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: formation.projectId,
      action: 'agent-formations:GetAgentFormation',
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    ctx.body = formation;
  }
);

agentFormationsRouter.put(
  '/agent-formations/:formation_id',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const formation = await getAgentFormation({ id: ctx.params.formation_id });
    if (!formation) {
      ctx.status = 404;
      ctx.body = { error: 'Agent formation not found' };
      return;
    }

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: formation.projectId,
      action: 'agent-formations:UpdateAgentFormation',
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const body = ctx.request.body as {
      template?: unknown;
      metadata?: Record<string, unknown> | null;
    };

    let parsedTemplate: unknown = undefined;
    if (body.template !== undefined) {
      parsedTemplate = parseFormationTemplateInput(body.template);
      const validation = validateFormationTemplate(parsedTemplate);
      if (!validation.valid) {
        ctx.status = 400;
        ctx.body = { error: 'Invalid template', details: validation.errors };
        return;
      }
    }

    const updated = await updateAgentFormation({
      id: ctx.params.formation_id,
      template: parsedTemplate as FormationTemplate | undefined,
      metadata: body.metadata,
    });

    ctx.body = updated;
  }
);

agentFormationsRouter.delete(
  '/agent-formations/:formation_id',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const formation = await getAgentFormation({ id: ctx.params.formation_id });
    if (!formation) {
      ctx.status = 404;
      ctx.body = { error: 'Agent formation not found' };
      return;
    }

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: formation.projectId,
      action: 'agent-formations:DeleteAgentFormation',
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    await deleteAgentFormation({ id: ctx.params.formation_id });
    ctx.status = 204;
  }
);

agentFormationsRouter.get(
  '/agent-formations/:formation_id/events',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const formation = await getAgentFormation({ id: ctx.params.formation_id });
    if (!formation) {
      ctx.status = 404;
      ctx.body = { error: 'Agent formation not found' };
      return;
    }

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: formation.projectId,
      action: 'agent-formations:ListAgentFormationEvents',
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    ctx.body = await listAgentFormationEvents({
      formationId: ctx.params.formation_id,
    });
  }
);
