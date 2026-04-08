import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import {
  addUserToProject,
  createProject,
  createProjectPolicy,
  listProjectPolicies,
} from 'src/lib/projects';

const projectsRouter = new Router<Context>();

/**
 * @openapi
 * /projects:
 *   post:
 *     tags:
 *       - Projects
 *     summary: Create a project
 *     description: Creates a new project. Only admins can create projects.
 *     operationId: createProject
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *                 example: 'My Project'
 *     responses:
 *       '201':
 *         description: Project created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ProjectRecord'
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '403':
 *         description: Forbidden
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
projectsRouter.post('/projects', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  if (ctx.authUser.role !== 'admin') {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const { name } = ctx.request.body as { name: string };

  const project = await createProject({ name });

  ctx.status = 201;
  ctx.body = project;
});

/**
 * @openapi
 * /projects/{projectId}/policies:
 *   get:
 *     tags:
 *       - Projects
 *     summary: List project policies
 *     description: Returns a list of policies for a project. Project members can list policies.
 *     operationId: listProjectPolicies
 *     parameters:
 *       - name: projectId
 *         in: path
 *         required: true
 *         description: Project ID
 *         schema:
 *           type: string
 *           example: 'proj_V1StGXR8Z5jdHi6B'
 *     responses:
 *       '200':
 *         description: List of policies returned successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/ProjectPolicyRecord'
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '403':
 *         description: Forbidden
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '404':
 *         description: Project not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
projectsRouter.get('/projects/:projectId/policies', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  // Check if user is member of the project
  const allowed = await ctx.authUser.isAllowed(
    ctx.params.projectId,
    'projects:GetProject'
  );
  if (!allowed) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const policies = await listProjectPolicies({
    projectId: ctx.params.projectId,
  });

  ctx.body = policies;
});

/**
 * @openapi
 * /projects/{projectId}/policies:
 *   post:
 *     tags:
 *       - Projects
 *     summary: Create a project policy
 *     description: Creates a new policy for a project. Only admins can create policies.
 *     operationId: createProjectPolicy
 *     parameters:
 *       - name: projectId
 *         in: path
 *         required: true
 *         description: Project ID
 *         schema:
 *           type: string
 *           example: 'proj_V1StGXR8Z5jdHi6B'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - permissions
 *             properties:
 *               permissions:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: ['files:read']
 *               notPermissions:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: ['files:delete']
 *     responses:
 *       '201':
 *         description: Policy created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ProjectPolicyRecord'
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '403':
 *         description: Forbidden
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '404':
 *         description: Project not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
projectsRouter.post('/projects/:projectId/policies', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  if (ctx.authUser.role !== 'admin') {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const { permissions, notPermissions } = ctx.request.body as {
    permissions: string[];
    notPermissions?: string[];
  };

  const policy = await createProjectPolicy({
    projectId: ctx.params.projectId,
    permissions,
    notPermissions,
  });

  if (!policy) {
    ctx.status = 404;
    ctx.body = { error: 'Project not found' };
    return;
  }

  ctx.status = 201;
  ctx.body = policy;
});

/**
 * @openapi
 * /projects/{projectId}/members:
 *   post:
 *     tags:
 *       - Projects
 *     summary: Add user to project
 *     description: Adds a user to a project with a specific policy. Only admins can add members.
 *     operationId: addUserToProject
 *     parameters:
 *       - name: projectId
 *         in: path
 *         required: true
 *         description: Project ID
 *         schema:
 *           type: string
 *           example: 'proj_V1StGXR8Z5jdHi6B'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userId
 *               - policyId
 *             properties:
 *               userId:
 *                 type: string
 *                 example: 'usr_V1StGXR8Z5jdHi6B'
 *               policyId:
 *                 type: string
 *                 example: 'pol_V1StGXR8Z5jdHi6B'
 *     responses:
 *       '201':
 *         description: User added to project successfully
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '403':
 *         description: Forbidden
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '404':
 *         description: Project, user, or policy not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
projectsRouter.post('/projects/:projectId/members', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  if (ctx.authUser.role !== 'admin') {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const { userId, policyId } = ctx.request.body as {
    userId: string;
    policyId: string;
  };

  const success = await addUserToProject({
    projectId: ctx.params.projectId,
    userId,
    policyId,
  });

  if (!success) {
    ctx.status = 404;
    ctx.body = { error: 'Project, user, or policy not found' };
    return;
  }

  ctx.status = 201;
});

export { projectsRouter };
