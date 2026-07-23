import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import {
  createApiKey,
  deleteApiKey,
  getApiKey,
  listApiKeys,
  updateApiKey,
} from 'src/lib/apiKeys';

import { parsePagination } from './helpers';

const apiKeysRouter = new Router<Context>();

/**
 * Resolves a project public ID to its internal ID.
 *
 * API keys may be scoped to a single project or left unscoped:
 * - `undefined` means "not provided" — an unscoped key on create, or "leave the
 *   scope unchanged" on update.
 * - `null` explicitly clears the scope (unscoped key).
 * - a public ID resolves to the project's internal ID, or errors if unknown.
 */
const resolveProjectId = async (args: {
  projectId: string | null | undefined;
}): Promise<{ id: number | null | undefined; error?: string }> => {
  if (args.projectId === undefined) {
    return { id: undefined };
  }
  if (args.projectId === null) {
    return { id: null };
  }

  const project = await db.Project.findOne({
    where: { publicId: args.projectId },
  });
  if (!project) {
    return { id: undefined, error: 'Invalid project' };
  }
  return { id: project.id as number };
};

/**
 * Resolves policy public IDs to their internal IDs
 */
const resolvePolicyIds = async (args: {
  policyIds: string[] | undefined;
}): Promise<{ ids: number[] | undefined; error?: string }> => {
  if (args.policyIds === undefined) {
    return { ids: undefined };
  }
  if (args.policyIds.length === 0) {
    return { ids: [] };
  }

  const policies = await db.Policy.findAll({
    where: { publicId: args.policyIds },
  });
  if (policies.length !== args.policyIds.length) {
    return { ids: undefined, error: 'One or more invalid policy IDs' };
  }

  return {
    ids: policies.map((p: InstanceType<(typeof db)['Policy']>) => {
      return p.id as number;
    }),
  };
};

apiKeysRouter.get('/api-keys', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  // When authenticated with an API key scoped to a project,
  // only show API keys scoped to that project
  if (ctx.authUser.apiKeyProjectId !== undefined) {
    ctx.body = await listApiKeys({
      projectId: ctx.authUser.apiKeyProjectId,
      ...parsePagination(ctx),
    });
    return;
  }

  // JWT admin sees all API keys
  if (ctx.authUser.role === 'admin') {
    ctx.body = await listApiKeys({ ...parsePagination(ctx) });
    return;
  }

  // JWT regular user sees only their own API keys
  ctx.body = await listApiKeys({
    userId: ctx.authUser.id,
    ...parsePagination(ctx),
  });
});

apiKeysRouter.post('/api-keys', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const { name, projectId, policyIds } = ctx.request.body as {
    name: string;
    projectId?: string | null;
    policyIds?: string[];
  };

  // project_id is optional: an omitted or null value creates an unscoped key.
  const projectResult = await resolveProjectId({ projectId });
  if (projectResult.error) {
    ctx.status = 400;
    ctx.body = { error: projectResult.error };
    return;
  }

  const policyResult = await resolvePolicyIds({ policyIds });
  if (policyResult.error) {
    ctx.status = 400;
    ctx.body = { error: policyResult.error };
    return;
  }

  const apiKey = await createApiKey({
    userId: ctx.authUser.id,
    name,
    projectId: projectResult.id,
    policyIds: policyResult.ids,
  });

  ctx.status = 201;
  ctx.body = apiKey;
});

apiKeysRouter.get('/api-keys/:api_key_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const apiKey = await getApiKey({ id: ctx.params.api_key_id });
  if (!apiKey) {
    ctx.status = 404;
    ctx.body = { error: 'API key not found' };
    return;
  }

  if (
    apiKey.userId !== ctx.authUser.publicId &&
    ctx.authUser.role !== 'admin'
  ) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  ctx.body = apiKey;
});

apiKeysRouter.put('/api-keys/:api_key_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const { name, projectId, policyIds } = ctx.request.body as {
    name?: string;
    projectId?: string | null;
    policyIds?: string[];
  };

  const existing = await getApiKey({ id: ctx.params.api_key_id });
  if (!existing) {
    ctx.status = 404;
    ctx.body = { error: 'API key not found' };
    return;
  }

  if (
    existing.userId !== ctx.authUser.publicId &&
    ctx.authUser.role !== 'admin'
  ) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  const projectResult = await resolveProjectId({ projectId });
  if (projectResult.error) {
    ctx.status = 400;
    ctx.body = { error: projectResult.error };
    return;
  }

  const policyResult = await resolvePolicyIds({ policyIds });
  if (policyResult.error) {
    ctx.status = 400;
    ctx.body = { error: policyResult.error };
    return;
  }

  const updated = await updateApiKey({
    id: ctx.params.api_key_id,
    name,
    projectId: projectResult.id,
    policyIds: policyResult.ids,
  });
  // projectResult.id: `undefined` = scope unchanged (project_id omitted),
  // `null` = scope cleared (unscoped), a number = re-scoped to that project.

  ctx.body = updated;
});

apiKeysRouter.delete('/api-keys/:api_key_id', async (ctx: Context) => {
  if (!ctx.authUser) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }

  const existing = await getApiKey({ id: ctx.params.api_key_id });
  if (!existing) {
    ctx.status = 404;
    ctx.body = { error: 'API key not found' };
    return;
  }

  if (
    existing.userId !== ctx.authUser.publicId &&
    ctx.authUser.role !== 'admin'
  ) {
    ctx.status = 403;
    ctx.body = { error: 'Forbidden' };
    return;
  }

  await deleteApiKey({ id: ctx.params.api_key_id });
  ctx.status = 204;
});

export { apiKeysRouter };
