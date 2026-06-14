import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import type { ConsentSelection } from 'src/lib/oauthConsent';
import { buildConsentPolicy, buildConsentScopes } from 'src/lib/oauthConsent';
import { getPermissionCatalog } from 'src/lib/permissionCatalog';
import { getProject, listProjects } from 'src/lib/projects';

const oauthRouter = new Router<Context>();

const parseSelection = (value: unknown): ConsentSelection => {
  if (!value || typeof value !== 'object') {
    throw new DomainError('VALIDATION_FAILED', 'selection is required.');
  }
  const sel = value as Record<string, unknown>;

  if (sel.kind === 'all') {
    return { kind: 'all' };
  }
  if (sel.kind === 'modules') {
    if (!Array.isArray(sel.modules)) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'selection.modules must be an array.'
      );
    }
    return { kind: 'modules', modules: sel.modules.map(String) };
  }
  if (sel.kind === 'actions') {
    if (!Array.isArray(sel.actions)) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'selection.actions must be an array.'
      );
    }
    return { kind: 'actions', actions: sel.actions.map(String) };
  }

  throw new DomainError(
    'VALIDATION_FAILED',
    "selection.kind must be one of 'all', 'modules', 'actions'."
  );
};

/**
 * @openapi
 * /api/v1/oauth/consent-info:
 *   get:
 *     operationId: getOauthConsentInfo
 *     summary: Data for rendering the OAuth consent screen
 *     description: >
 *       Returns the projects the caller can grant access to and the full
 *       permission catalog (modules and their granular actions) used to render
 *       the three-tier permission selector.
 *     tags: [OAuth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       '200':
 *         description: Consent screen data.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OauthConsentInfo'
 *       '401':
 *         description: Unauthenticated.
 */
oauthRouter.get('/oauth/consent-info', async (ctx: Context) => {
  if (!ctx.authUser) {
    throw new DomainError('UNAUTHORIZED', 'Unauthorized');
  }

  const projects = await listProjects({ authUser: ctx.authUser });
  const catalog = getPermissionCatalog();

  ctx.status = 200;
  ctx.body = {
    projects: projects.map((p) => {
      return { id: p.id, name: p.name };
    }),
    modules: catalog.modules,
  };
});

/**
 * @openapi
 * /api/v1/oauth/consent:
 *   post:
 *     operationId: createOauthConsent
 *     summary: Resolve a consent selection into scopes and an IAM policy
 *     description: >
 *       Validates the chosen project and permission selection and returns the
 *       granted scopes and the project-scoped IAM policy document that an
 *       issued access token would carry. The selection may grant all
 *       permissions, whole modules, or individual actions.
 *     tags: [OAuth]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/OauthConsentRequest'
 *     responses:
 *       '200':
 *         description: Resolved scopes and policy.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OauthConsentResult'
 *       '400':
 *         description: Invalid selection.
 *       '401':
 *         description: Unauthenticated.
 *       '403':
 *         description: No access to the requested project.
 */
oauthRouter.post('/oauth/consent', async (ctx: Context) => {
  if (!ctx.authUser) {
    throw new DomainError('UNAUTHORIZED', 'Unauthorized');
  }

  const body = (ctx.request.body ?? {}) as {
    projectId?: string;
    selection?: unknown;
  };

  if (!body.projectId || typeof body.projectId !== 'string') {
    throw new DomainError('VALIDATION_FAILED', 'project_id is required.');
  }

  // getProject enforces access — throws RESOURCE_NOT_FOUND (404) or FORBIDDEN (403)
  await getProject({ id: body.projectId, authUser: ctx.authUser });

  const selection = parseSelection(body.selection);
  const scopes = buildConsentScopes(selection);
  const policy = buildConsentPolicy({
    projectPublicId: body.projectId,
    selection,
  });

  ctx.status = 200;
  ctx.body = { projectId: body.projectId, scopes, policy };
});

export { oauthRouter };
