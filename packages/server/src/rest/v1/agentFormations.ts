import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import {
  createAgentFormation,
  deleteAgentFormation,
  getAgentFormation,
  listAgentFormationEvents,
  listAgentFormations,
  planAgentFormation,
  updateAgentFormation,
  validateFormationTemplate,
  type FormationTemplate,
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

/**
 * @openapi
 * /api/v1/agent-formations/validate:
 *   post:
 *     summary: Validate a formation template
 *     operationId: validateAgentFormation
 *     tags: [AgentFormations]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [template]
 *             properties:
 *               template:
 *                 $ref: '#/components/schemas/FormationTemplate'
 *     responses:
 *       200:
 *         description: Validation result
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ValidationResult'
 *       401:
 *         description: Unauthorized
 */
agentFormationsRouter.post(
  '/agent-formations/validate',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const body = ctx.request.body as { template?: unknown };
    ctx.body = validateFormationTemplate(body.template);
  }
);

/**
 * @openapi
 * /api/v1/agent-formations/plan:
 *   post:
 *     summary: Plan a formation deployment
 *     operationId: planAgentFormation
 *     tags: [AgentFormations]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [project_id, template]
 *             properties:
 *               project_id:
 *                 type: string
 *               formation_id:
 *                 type: string
 *               template:
 *                 $ref: '#/components/schemas/FormationTemplate'
 *     responses:
 *       200:
 *         description: Plan result
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PlanResult'
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 */
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

  const validation = validateFormationTemplate(body.template);
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
    template: body.template as FormationTemplate,
    formationId: body.formationId,
  });
});

/**
 * @openapi
 * /api/v1/agent-formations:
 *   post:
 *     summary: Create a new agent formation
 *     operationId: createAgentFormation
 *     tags: [AgentFormations]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [project_id, name, template]
 *             properties:
 *               project_id:
 *                 type: string
 *               name:
 *                 type: string
 *               template:
 *                 $ref: '#/components/schemas/FormationTemplate'
 *               metadata:
 *                 type: object
 *     responses:
 *       201:
 *         description: Formation created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AgentFormation'
 *       400:
 *         description: Bad Request
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       409:
 *         description: Conflict
 */
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

  const validation = validateFormationTemplate(body.template);
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
    template: body.template as FormationTemplate,
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

/**
 * @openapi
 * /api/v1/agent-formations:
 *   get:
 *     summary: List agent formations
 *     operationId: listAgentFormations
 *     tags: [AgentFormations]
 *     parameters:
 *       - name: project_id
 *         in: query
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of formations
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/AgentFormation'
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 */
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

/**
 * @openapi
 * /api/v1/agent-formations/{formation_id}:
 *   get:
 *     summary: Get a specific agent formation
 *     operationId: getAgentFormation
 *     tags: [AgentFormations]
 *     parameters:
 *       - name: formation_id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Formation details
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AgentFormation'
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Not Found
 */
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

/**
 * @openapi
 * /api/v1/agent-formations/{formation_id}:
 *   put:
 *     summary: Update an agent formation
 *     operationId: updateAgentFormation
 *     tags: [AgentFormations]
 *     parameters:
 *       - name: formation_id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               template:
 *                 $ref: '#/components/schemas/FormationTemplate'
 *               metadata:
 *                 type: object
 *                 nullable: true
 *     responses:
 *       200:
 *         description: Updated formation
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AgentFormation'
 *       400:
 *         description: Bad Request
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Not Found
 */
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

    if (body.template !== undefined) {
      const validation = validateFormationTemplate(body.template);
      if (!validation.valid) {
        ctx.status = 400;
        ctx.body = { error: 'Invalid template', details: validation.errors };
        return;
      }
    }

    const updated = await updateAgentFormation({
      id: ctx.params.formation_id,
      template: body.template as FormationTemplate | undefined,
      metadata: body.metadata,
    });

    ctx.body = updated;
  }
);

/**
 * @openapi
 * /api/v1/agent-formations/{formation_id}:
 *   delete:
 *     summary: Delete an agent formation and all its managed resources
 *     operationId: deleteAgentFormation
 *     tags: [AgentFormations]
 *     parameters:
 *       - name: formation_id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       204:
 *         description: Deleted
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Not Found
 */
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

/**
 * @openapi
 * /api/v1/agent-formations/{formation_id}/events:
 *   get:
 *     summary: List operation events for a formation
 *     operationId: listAgentFormationEvents
 *     tags: [AgentFormations]
 *     parameters:
 *       - name: formation_id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of operations with events
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/FormationOperation'
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Not Found
 */
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
