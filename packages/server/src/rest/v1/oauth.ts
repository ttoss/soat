import { randomUUID } from 'node:crypto';

import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';
import type { ConsentSelection } from 'src/lib/oauthConsent';
import { buildConsentPolicy, buildConsentScopes } from 'src/lib/oauthConsent';
import { getPermissionCatalog } from 'src/lib/permissionCatalog';
import { getProject, listProjects } from 'src/lib/projects';
import {
  CONSENT_COOKIE,
  PROJECT_SCOPE_PREFIX,
  putConsentSession,
} from 'src/oauth/server';

const oauthRouter = new Router<Context>();

const MCP_ACCESS_SCOPE = 'mcp:access';
const CONSENT_COOKIE_MAX_AGE_MS = 10 * 60 * 1000;

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
 *       the three-tier permission selector in the app.
 *     tags: [OAuth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       '200':
 *         description: Consent screen data.
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
 *     summary: Record a consent decision and resolve it into scopes + an IAM policy
 *     description: >
 *       Validates the chosen project and permission selection and returns the
 *       granted scopes and the project-scoped IAM policy document an issued
 *       access token would carry. The selection may grant all permissions,
 *       whole modules, or individual actions.
 *
 *       When `authorize_query` (the original OAuth `/authorize` query string)
 *       is supplied, a single-use consent grant is stored, a consent cookie is
 *       set, and `authorize_url` is returned for the app to navigate back to so
 *       the authorization server can complete the flow.
 *     tags: [OAuth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       '200':
 *         description: Resolved scopes/policy (and authorize_url when authorizing).
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
    authorizeQuery?: string;
  };

  if (!body.projectId || typeof body.projectId !== 'string') {
    throw new DomainError('VALIDATION_FAILED', 'project_id is required.');
  }

  // getProject enforces access — throws RESOURCE_NOT_FOUND (404) or FORBIDDEN (403)
  await getProject({ id: body.projectId, authUser: ctx.authUser });

  const selection = parseSelection(body.selection);
  const granted = buildConsentScopes(selection);
  const policy = buildConsentPolicy({
    projectPublicId: body.projectId,
    selection,
  });

  const result: {
    projectId: string;
    scopes: string[];
    policy: typeof policy;
    authorizeUrl?: string;
  } = { projectId: body.projectId, scopes: granted, policy };

  // When completing an OAuth flow, store the grant, set the consent cookie, and
  // hand the app the URL to navigate back to so /authorize can issue a code.
  if (typeof body.authorizeQuery === 'string' && body.authorizeQuery.length) {
    const scopes = [
      ...granted,
      MCP_ACCESS_SCOPE,
      `${PROJECT_SCOPE_PREFIX}${body.projectId}`,
    ];
    const consentId = randomUUID();
    putConsentSession({
      id: consentId,
      subject: ctx.authUser.publicId,
      scopes,
    });
    ctx.cookies.set(CONSENT_COOKIE, consentId, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: CONSENT_COOKIE_MAX_AGE_MS,
    });
    result.authorizeUrl = `/authorize?${body.authorizeQuery}`;
  }

  ctx.status = 200;
  ctx.body = result;
});

export { oauthRouter };
