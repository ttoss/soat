import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import type { PolicyDocument } from 'src/lib/iam';
import {
  createPolicy,
  deletePolicy,
  getPolicy,
  listPolicies,
  updatePolicy,
} from 'src/lib/policies';

const policiesRouter = new Router<Context>();

/**
 * @openapi
 * /api/v1/policies:
 *   get:
 *     tags: [Policies]
 *     summary: List all policies
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Array of policies
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 */
policiesRouter.get('/policies', async (ctx: Context) => {
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

  ctx.body = await listPolicies();
});

/**
 * @openapi
 * /api/v1/policies:
 *   post:
 *     tags: [Policies]
 *     summary: Create a policy
 *     security:
 *       - bearerAuth: []
 */
policiesRouter.post('/policies', async (ctx: Context) => {
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

  const { name, description, permissions, notPermissions, document } = ctx
    .request.body as {
    name?: string;
    description?: string;
    permissions?: string[];
    notPermissions?: string[];
    document?: object;
  };

  const policyDocument: PolicyDocument = document
    ? (document as PolicyDocument)
    : {
        statement: [
          ...(permissions?.length
            ? [{ effect: 'Allow' as const, action: permissions }]
            : []),
          ...(notPermissions?.length
            ? [{ effect: 'Deny' as const, action: notPermissions }]
            : []),
        ],
      };

  const result = await createPolicy({
    name,
    description,
    document: policyDocument,
  });

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
 * /api/v1/policies/{policyId}:
 *   get:
 *     tags: [Policies]
 *     summary: Get a policy by ID
 *     security:
 *       - bearerAuth: []
 */
policiesRouter.get('/policies/:policyId', async (ctx: Context) => {
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

  const policy = await getPolicy({ policyId: ctx.params.policyId });

  if (!policy) {
    ctx.status = 404;
    ctx.body = { error: 'Policy not found' };
    return;
  }

  ctx.body = policy;
});

/**
 * @openapi
 * /api/v1/policies/{policyId}:
 *   put:
 *     tags: [Policies]
 *     summary: Update a policy
 *     security:
 *       - bearerAuth: []
 */
policiesRouter.put('/policies/:policyId', async (ctx: Context) => {
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

  if (!document) {
    ctx.status = 400;
    ctx.body = { error: 'document is required' };
    return;
  }

  const result = await updatePolicy({
    policyId: ctx.params.policyId,
    name,
    description,
    document: document as PolicyDocument,
  });

  if (result === 'not_found') {
    ctx.status = 404;
    ctx.body = { error: 'Policy not found' };
    return;
  }

  if ('invalid' in result) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid policy document', details: result.errors };
    return;
  }

  ctx.body = result;
});

/**
 * @openapi
 * /api/v1/policies/{policyId}:
 *   delete:
 *     tags: [Policies]
 *     summary: Delete a policy
 *     security:
 *       - bearerAuth: []
 */
policiesRouter.delete('/policies/:policyId', async (ctx: Context) => {
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

  const result = await deletePolicy({ policyId: ctx.params.policyId });

  if (result === 'not_found') {
    ctx.status = 404;
    ctx.body = { error: 'Policy not found' };
    return;
  }

  ctx.status = 204;
});

export { policiesRouter };
