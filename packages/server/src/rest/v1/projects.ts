import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import {
  addUserToProject,
  createProject,
  createProjectPolicy,
  deleteProject,
  deleteProjectPolicy,
  getProject,
  getProjectPolicy,
  getUserProjectPolicies,
  listProjectPolicies,
  listProjects,
  updateProjectPolicy,
  updateUserProjectPolicies,
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

  const { name } = ctx.request.body as { name?: string };

  if (!name || typeof name !== 'string') {
    ctx.status = 400;
    ctx.body = { error: 'name is required' };
    return;
  }

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
  const allowed = await ctx.authUser.isAllowed({
    projectPublicId: ctx.params.projectId,
    action: 'projects:GetProject',
  });
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
 *       content:document
 *             properties:
 *               name:
 *                 type: string
 *                 example: 'Document Readers'
 *               description:
 *                 type: string
 *                 example: 'Read-only access to documents'
 *               document:
 *                 type: object
 *                 description: PolicyDocument JSON
 *     responses:
 *       '201':
 *         description: Policy created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ProjectPolicyRecord'
 *       '400':
 *         description: Invalid policy document
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
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

  const { name, description, permissions, notPermissions } = ctx.request
    .body as {
    name?: string;
    description?: string;
    permissions: string[];
    notPermissions?: string[];
  };

  const document: import('src/lib/iam').PolicyDocument = {
    statement: [
      ...(permissions?.length
        ? [{ effect: 'Allow' as const, action: permissions }]
        : []),
      ...(notPermissions?.length
        ? [{ effect: 'Deny' as const, action: notPermissions }]
        : []),
    ],
  };

  const result = await createProjectPolicy({
    projectId: ctx.params.projectId,
    name,
    description,
    document,
  });

  if (result === 'not_found') {
    ctx.status = 404;
    ctx.body = { error: 'Project not found' };
    return;
  }

  if ('invalid' in result) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid policy document', details: result.errors };
    return;
  }

  ctx.status = 201;
  ctx.body = result;
});

/**
 * @openapi
 * /projects/{projectId}/policies/{policyId}:
 *   put:
 *     tags:
 *       - Projects
 *     summary: Update a project policy
 *     description: Replaces a policy document. Only admins can update policies.
 *     operationId: updateProjectPolicy
 *     parameters:
 *       - name: projectId
 *         in: path
 *         required: true
 *         description: Project ID
 *         schema:
 *           type: string
 *       - name: policyId
 *         in: path
 *         required: true
 *         description: Policy ID
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - document
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               document:
 *                 type: object
 *     responses:
 *       '200':
 *         description: Policy updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ProjectPolicyRecord'
 *       '400':
 *         description: Invalid policy document
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
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
 *         description: Project or policy not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
projectsRouter.put(
  '/projects/:projectId/policies/:policyId',
  async (ctx: Context) => {
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

    const { name, description, document } = ctx.request.body as {
      name?: string;
      description?: string;
      document: object;
    };

    const result = await updateProjectPolicy({
      projectId: ctx.params.projectId,
      policyId: ctx.params.policyId,
      name,
      description,
      document: document as import('src/lib/iam').PolicyDocument,
    });

    if (result === 'not_found') {
      ctx.status = 404;
      ctx.body = { error: 'Project or policy not found' };
      return;
    }

    if ('invalid' in result) {
      ctx.status = 400;
      ctx.body = { error: 'Invalid policy document', details: result.errors };
      return;
    }

    ctx.body = result;
  }
);

/**
 * @openapi
 * /projects/{projectId}/policies/{policyId}:
 *   delete:
 *     tags:
 *       - Projects
 *     summary: Delete a project policy
 *     description: Deletes a policy. Only admins can delete policies.
 *     operationId: deleteProjectPolicy
 *     parameters:
 *       - name: projectId
 *         in: path
 *         required: true
 *         description: Project ID
 *         schema:
 *           type: string
 *       - name: policyId
 *         in: path
 *         required: true
 *         description: Policy ID
 *         schema:
 *           type: string
 *     responses:
 *       '204':
 *         description: Policy deleted successfully
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
 *         description: Project or policy not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
projectsRouter.delete(
  '/projects/:projectId/policies/:policyId',
  async (ctx: Context) => {
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

    const result = await deleteProjectPolicy({
      projectId: ctx.params.projectId,
      policyId: ctx.params.policyId,
    });

    if (result === 'not_found') {
      ctx.status = 404;
      ctx.body = { error: 'Project or policy not found' };
      return;
    }

    ctx.status = 204;
  }
);

/**
 * @openapi
 * /projects/{projectId}/policies/{policyId}:
 *   get:
 *     tags:
 *       - Projects
 *     summary: Get a project policy
 *     description: Returns a single policy for a project.
 *     operationId: getProjectPolicy
 *     parameters:
 *       - name: projectId
 *         in: path
 *         required: true
 *         description: Project ID
 *         schema:
 *           type: string
 *       - name: policyId
 *         in: path
 *         required: true
 *         description: Policy ID
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Policy returned successfully
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
 *         description: Policy not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
projectsRouter.get(
  '/projects/:projectId/policies/:policyId',
  async (ctx: Context) => {
    if (!ctx.authUser) {
      ctx.status = 401;
      ctx.body = { error: 'Unauthorized' };
      return;
    }

    const allowed = await ctx.authUser.isAllowed({
      projectPublicId: ctx.params.projectId,
      action: 'projects:GetProject',
    });
    if (!allowed) {
      ctx.status = 403;
      ctx.body = { error: 'Forbidden' };
      return;
    }

    const policy = await getProjectPolicy({
      projectId: ctx.params.projectId,
      policyId: ctx.params.policyId,
    });

    if (!policy) {
      ctx.status = 404;
      ctx.body = { error: 'Policy not found' };
      return;
    }

    ctx.body = policy;
  }
);

/**
 * @openapi
 * /projects/{projectId}/policies/{policyId}:
 *   put:
 *     tags:
 *       - Projects
 *     summary: Update a project policy
 *             properties:
 *               userId:
 *                 type: string
 *                 example: 'usr_V1StGXR8Z5jdHi6B'
 *               policyIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: ['pol_V1StGXR8Z5jdHi6B']
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

  const { userId, policyId, policyIds } = ctx.request.body as {
    userId: string;
    policyId?: string;
    policyIds?: string[];
  };

  const resolvedPolicyIds = policyIds ?? (policyId ? [policyId] : undefined);

  const success = await addUserToProject({
    projectId: ctx.params.projectId,
    userId,
    policyIds: resolvedPolicyIds,
  });

  if (!success) {
    ctx.status = 404;
    ctx.body = { error: 'Project, user, or policy not found' };
    return;
  }

  ctx.status = 201;
});

/**
 * @openapi
 * /projects/{projectId}/members/{userId}/policies:
 *   put:
 *     tags:
 *       - Projects
 *     summary: Update member policies
 *     description: Replaces the list of policies attached to a member. Only admins can update member policies.
 *     operationId: updateUserProjectPolicies
 *     parameters:
 *       - name: projectId
 *         in: path
 *         required: true
 *         description: Project ID
 *         schema:
 *           type: string
 *       - name: userId
 *         in: path
 *         required: true
 *         description: User ID
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - policyIds
 *             properties:
 *               policyIds:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       '204':
 *         description: Member policies updated successfully
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
projectsRouter.put(
  '/projects/:projectId/members/:userId/policies',
  async (ctx: Context) => {
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

    const { policyIds } = ctx.request.body as { policyIds: string[] };

    const result = await updateUserProjectPolicies({
      projectId: ctx.params.projectId,
      userId: ctx.params.userId,
      policyIds,
    });

    if (result === 'not_found') {
      ctx.status = 404;
      ctx.body = { error: 'Project, user, membership, or policy not found' };
      return;
    }

    ctx.status = 204;
  }
);

/**
 * @openapi
 * /projects/{projectId}/members/{userId}/policies:
 *   get:
 *     tags:
 *       - Projects
 *     summary: Get member policies
 *     description: Returns the list of policies attached to a project member.
 *     operationId: getUserProjectPolicies
 *     parameters:
 *       - name: projectId
 *         in: path
 *         required: true
 *         description: Project ID
 *         schema:
 *           type: string
 *       - name: userId
 *         in: path
 *         required: true
 *         description: User ID
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Member policies returned successfully
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
 *         description: Project or user not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
projectsRouter.get(
  '/projects/:projectId/members/:userId/policies',
  async (ctx: Context) => {
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

    const policies = await getUserProjectPolicies({
      projectId: ctx.params.projectId,
      userId: ctx.params.userId,
    });

    if (policies === null) {
      ctx.status = 404;
      ctx.body = { error: 'Project or user not found' };
      return;
    }

    ctx.body = policies;
  }
);

/**
 * @openapi
 * /projects:
 *   get:
 *     tags:
 *       - Projects
 *     summary: List projects
 *     description: Admins see all projects. Members see only their own projects.
 *     operationId: listProjects
 *     responses:
 *       '200':
 *         description: List of projects returned successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/ProjectRecord'
 *       '401':
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
projectsRouter.get('/projects', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const projects = await listProjects({ authUser: ctx.authUser });
  ctx.body = projects;
});

/**
 * @openapi
 * /projects/{id}:
 *   get:
 *     tags:
 *       - Projects
 *     summary: Get a project
 *     description: Admins can get any project. Members can only get projects they belong to.
 *     operationId: getProject
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: Project ID
 *         schema:
 *           type: string
 *           example: 'proj_V1StGXR8Z5jdHi6B'
 *     responses:
 *       '200':
 *         description: Project returned successfully
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
 *       '404':
 *         description: Project not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
projectsRouter.get('/projects/:id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const result = await getProject({
    id: ctx.params.id,
    authUser: ctx.authUser,
  });

  if (result === 'not_found') {
    ctx.status = 404;
    ctx.body = { error: 'Project not found' };
    return;
  }

  if (result === 'forbidden') {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = result;
});

/**
 * @openapi
 * /projects/{id}:
 *   delete:
 *     tags:
 *       - Projects
 *     summary: Delete a project
 *     description: Only admins can delete projects.
 *     operationId: deleteProject
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: Project ID
 *         schema:
 *           type: string
 *           example: 'proj_V1StGXR8Z5jdHi6B'
 *     responses:
 *       '204':
 *         description: Project deleted successfully
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
projectsRouter.delete('/projects/:id', async (ctx: Context) => {
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

  const result = await deleteProject({ id: ctx.params.id });

  if (!result) {
    ctx.status = 404;
    ctx.body = { error: 'Project not found' };
    return;
  }

  ctx.status = 204;
});

export { projectsRouter };
