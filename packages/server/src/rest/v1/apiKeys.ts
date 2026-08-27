import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { db } from 'src/db';
import { DomainError } from 'src/errors';
import {
  createApiKey,
  deleteApiKey,
  getApiKey,
  listApiKeys,
  updateApiKey,
} from 'src/lib/apiKeys';
import { recordAuthorizationDecision } from 'src/middleware/audit';

import {
  assertCredentialProjectScope,
  parsePagination,
  requireAuth,
  requireOwnerOrAdmin,
} from './helpers';

const apiKeysRouter = new Router<Context>();

/**
 * The project a scoped credential is confined to, or `undefined` when it is
 * unscoped and may manage keys in any project its owner can reach.
 *
 * Key management is the one surface where the binding has to guard the
 * *credential being written*, not just a resource being read. Every resource
 * route resolves its project through the shared preamble, so a key scoped to
 * project A cannot touch project B — but `POST /api-keys` is self-service
 * (`requireAuth` and nothing else), so that same confined key could mint a
 * brand-new **unscoped** key for its owning user and be outside its boundary in
 * one call. The item routes, gated on owner-or-admin alone, then let it read,
 * re-scope, or delete that owner's keys in any project (#1038). A per-tenant
 * credential handed to a fronting service is only a boundary if it cannot mint
 * its way past it.
 *
 * Every route below therefore runs `assertCredentialProjectScope` against the
 * project of the key it is about to create, read, or write — passing `null` for
 * an unscoped key, which a confined credential may not manage either.
 */
const credentialProjectPublicId = (ctx: Context): string | undefined => {
  return (
    ctx.authUser?.apiKeyProjectPublicId ?? ctx.authUser?.oauthProjectPublicId
  );
};

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

/**
 * Numeric id of the project a scoped OAuth token is confined to, for the list
 * filter (an API key already carries its own as `apiKeyProjectId`).
 *
 * `undefined` when the credential is unscoped, or when its project row is gone —
 * which matches how `resolveProjectKey` already degrades a scoped API key whose
 * project was deleted, rather than inventing a second answer for the same state.
 */
const resolveScopedProjectId = async (args: {
  projectPublicId?: string;
}): Promise<number | undefined> => {
  if (!args.projectPublicId) {
    return undefined;
  }

  const project = await db.Project.findOne({
    where: { publicId: args.projectPublicId },
  });

  return (project?.id as number | undefined) ?? undefined;
};

apiKeysRouter.get('/api-keys', async (ctx: Context) => {
  requireAuth(ctx);

  // The read half of the boundary the item routes enforce below. A
  // project-scoped OAuth token carries its project as a public id rather than
  // `apiKeyProjectId`, so it is filtered here too instead of falling through to
  // the owner-wide branch.
  const scopedProjectId =
    ctx.authUser.apiKeyProjectId ??
    (await resolveScopedProjectId({
      projectPublicId: ctx.authUser.oauthProjectPublicId,
    }));

  if (scopedProjectId !== undefined) {
    ctx.body = await listApiKeys({
      projectId: scopedProjectId,
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
  requireAuth(ctx);

  const {
    name,
    project_id: projectId,
    policy_ids: policyIds,
  } = ctx.request.body as {
    name: string;
    project_id?: string | null;
    policy_ids?: string[];
  };

  /* A confined credential mints only into its own project. Omitting project_id
   * defaults to that project — the same implicit-project rule every write route
   * follows — so a fronting service can still rotate its own key; naming another
   * project, or asking for an unscoped key with an explicit null, is a 403. */
  const scopedProject = credentialProjectPublicId(ctx);
  const targetProjectId = projectId === undefined ? scopedProject : projectId;

  assertCredentialProjectScope({
    ctx,
    requestedProjectPublicId: targetProjectId ?? null,
    action: 'api-keys:CreateApiKey',
  });

  // project_id is optional: an omitted or null value creates an unscoped key.
  const projectResult = await resolveProjectId({ projectId: targetProjectId });
  if (projectResult.error) {
    throw new DomainError('VALIDATION_FAILED', projectResult.error);
  }

  const policyResult = await resolvePolicyIds({ policyIds });
  if (policyResult.error) {
    throw new DomainError('VALIDATION_FAILED', policyResult.error);
  }

  const apiKey = await createApiKey({
    userId: ctx.authUser.id,
    name,
    projectId: projectResult.id,
    policyIds: policyResult.ids,
  });

  // Self-service — any authenticated caller may create a key for themselves,
  // so there is no allow/deny branch to record; this is the one point that
  // makes the mutation visible to the audit log at all (see #745).
  recordAuthorizationDecision(ctx, {
    action: 'api-keys:CreateApiKey',
    allowed: true,
  });

  ctx.status = 201;
  ctx.body = apiKey;
});

apiKeysRouter.get('/api-keys/:api_key_id', async (ctx: Context) => {
  requireAuth(ctx);

  const apiKey = await getApiKey({ id: ctx.params.api_key_id });
  if (!apiKey) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'API key not found');
  }

  assertCredentialProjectScope({
    ctx,
    requestedProjectPublicId: apiKey.project_id,
    action: 'api-keys:GetApiKey',
  });

  requireOwnerOrAdmin(ctx, {
    ownerPublicId: apiKey.user_id,
    action: 'api-keys:GetApiKey',
  });

  ctx.body = apiKey;
});

apiKeysRouter.put('/api-keys/:api_key_id', async (ctx: Context) => {
  requireAuth(ctx);

  const {
    name,
    project_id: projectId,
    policy_ids: policyIds,
  } = ctx.request.body as {
    name?: string;
    project_id?: string | null;
    policy_ids?: string[];
  };

  const existing = await getApiKey({ id: ctx.params.api_key_id });
  if (!existing) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'API key not found');
  }

  // Both ends of a re-scope are checked: the key as it stands, and the project
  // the update would move it to. Checking only the former would let a confined
  // credential re-scope its own key out of the boundary it is standing in.
  assertCredentialProjectScope({
    ctx,
    requestedProjectPublicId: existing.project_id,
    action: 'api-keys:UpdateApiKey',
  });

  if (projectId !== undefined) {
    assertCredentialProjectScope({
      ctx,
      requestedProjectPublicId: projectId,
      action: 'api-keys:UpdateApiKey',
    });
  }

  requireOwnerOrAdmin(ctx, {
    ownerPublicId: existing.user_id,
    action: 'api-keys:UpdateApiKey',
  });

  const projectResult = await resolveProjectId({ projectId });
  if (projectResult.error) {
    throw new DomainError('VALIDATION_FAILED', projectResult.error);
  }

  const policyResult = await resolvePolicyIds({ policyIds });
  if (policyResult.error) {
    throw new DomainError('VALIDATION_FAILED', policyResult.error);
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
  requireAuth(ctx);

  const existing = await getApiKey({ id: ctx.params.api_key_id });
  if (!existing) {
    throw new DomainError('RESOURCE_NOT_FOUND', 'API key not found');
  }

  assertCredentialProjectScope({
    ctx,
    requestedProjectPublicId: existing.project_id,
    action: 'api-keys:DeleteApiKey',
  });

  requireOwnerOrAdmin(ctx, {
    ownerPublicId: existing.user_id,
    action: 'api-keys:DeleteApiKey',
  });

  await deleteApiKey({ id: ctx.params.api_key_id });
  ctx.status = 204;
});

export { apiKeysRouter };
