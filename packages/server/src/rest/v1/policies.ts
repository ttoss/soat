import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import type { PolicyDocument } from 'src/lib/iam';
import {
  createPolicy,
  deletePolicy,
  getPolicy,
  listPolicies,
  updatePolicy,
} from 'src/lib/policies';

import { parsePagination, requireAdmin } from './helpers';

const policiesRouter = new Router<Context>();

policiesRouter.get('/policies', async (ctx: Context) => {
  requireAdmin(ctx, 'policies:ListPolicies');
  const userId = ctx.query.user_id as string | undefined;
  ctx.body = await listPolicies({ userId, ...parsePagination(ctx) });
});

policiesRouter.post('/policies', async (ctx: Context) => {
  requireAdmin(ctx, 'policies:CreatePolicy');
  const { name, description, document } = ctx.request.body as {
    name?: string;
    description?: string;
    document?: object;
  };

  const result = await createPolicy({
    name,
    description,
    document: document as PolicyDocument,
  });

  if ('invalid' in result) {
    throw new DomainError('VALIDATION_FAILED', 'Invalid policy document', {
      details: result.errors,
    });
  }

  ctx.status = 201;
  ctx.body = result;
});

policiesRouter.get('/policies/:policy_id', async (ctx: Context) => {
  requireAdmin(ctx, 'policies:GetPolicy');
  const policy = await getPolicy({ policyId: ctx.params.policy_id });

  if (!policy) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'Policy not found');
  }

  ctx.body = policy;
});

policiesRouter.put('/policies/:policy_id', async (ctx: Context) => {
  requireAdmin(ctx, 'policies:UpdatePolicy');
  const { name, description, document } = ctx.request.body as {
    name?: string;
    description?: string;
    document: object;
  };

  const result = await updatePolicy({
    policyId: ctx.params.policy_id,
    name,
    description,
    document: document as PolicyDocument,
  });

  if ('invalid' in result) {
    throw new DomainError('VALIDATION_FAILED', 'Invalid policy document', {
      details: result.errors,
    });
  }

  ctx.body = result;
});

policiesRouter.delete('/policies/:policy_id', async (ctx: Context) => {
  requireAdmin(ctx, 'policies:DeletePolicy');
  await deletePolicy({ policyId: ctx.params.policy_id });

  ctx.status = 204;
});

export { policiesRouter };
