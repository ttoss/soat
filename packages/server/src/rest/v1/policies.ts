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

  const { name, description, document } = ctx.request.body as {
    name?: string;
    description?: string;
    document?: object;
  };

  if (!document) {
    ctx.status = 400;
    ctx.body = { error: 'document is required' };
    return;
  }

  const result = await createPolicy({
    name,
    description,
    document: document as PolicyDocument,
  });

  if ('invalid' in result) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid policy document', details: result.errors };
    return;
  }

  ctx.status = 201;
  ctx.body = result;
});

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
