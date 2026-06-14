/**
 * Serves the OAuth consent screen and processes the user's decision.
 *
 * "Login is done on the app": these routes require an authenticated SOAT user
 * (the app/SPA calls them with the user's bearer token, set by the global
 * `authMiddleware`). The screen lets the user pick a project and permissions;
 * on submit we record a single-use consent grant, set a cookie, and bounce
 * back to the OAuth `/authorize` endpoint, which the authorization server then
 * approves by reading that cookie.
 */
import { randomUUID } from 'node:crypto';

import { Router } from '@ttoss/http-server';
import createDebug from 'debug';

import type { Context } from '../Context';
import { DomainError } from '../errors';
import { buildConsentPolicy, buildConsentScopes } from '../lib/oauthConsent';
import { getPermissionCatalog } from '../lib/permissionCatalog';
import { getProject, listProjects } from '../lib/projects';
import { parseConsentForm, renderConsentScreen } from './consentScreen';
import {
  CONSENT_COOKIE,
  PROJECT_SCOPE_PREFIX,
  putConsentSession,
} from './server';

const log = createDebug('soat:oauth-consent-page');

const DECISION_PATH = '/oauth/consent/decision';
const AUTHORIZE_PATH = '/authorize';
const MCP_ACCESS_SCOPE = 'mcp:access';

/** OAuth authorize params we carry through the form unchanged. */
const OAUTH_PARAM_KEYS = [
  'client_id',
  'redirect_uri',
  'response_type',
  'scope',
  'state',
  'code_challenge',
  'code_challenge_method',
] as const;

const pickOauthParams = (
  source: Record<string, unknown>
): Record<string, string> => {
  const params: Record<string, string> = {};
  for (const key of OAUTH_PARAM_KEYS) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) {
      params[key] = value;
    }
  }
  return params;
};

const oauthConsentPageRouter = new Router<Context>();

oauthConsentPageRouter.get('/oauth/consent', async (ctx: Context) => {
  if (!ctx.authUser) {
    throw new DomainError('UNAUTHORIZED', 'Unauthorized');
  }

  const projects = await listProjects({ authUser: ctx.authUser });
  const catalog = getPermissionCatalog();

  ctx.type = 'text/html; charset=utf-8';
  ctx.body = renderConsentScreen({
    action: DECISION_PATH,
    oauthParams: pickOauthParams(ctx.query as Record<string, unknown>),
    projects: projects.map((p) => {
      return { id: p.id as string, name: p.name as string };
    }),
    modules: catalog.modules,
  });
});

oauthConsentPageRouter.post(DECISION_PATH, async (ctx: Context) => {
  if (!ctx.authUser) {
    throw new DomainError('UNAUTHORIZED', 'Unauthorized');
  }

  const body = (ctx.request.body ?? {}) as Record<string, unknown>;
  const projectId = body.project_id;

  if (typeof projectId !== 'string' || projectId.length === 0) {
    throw new DomainError('VALIDATION_FAILED', 'project_id is required.');
  }

  // Enforces project access — throws 404/403.
  await getProject({ id: projectId, authUser: ctx.authUser });

  const selection = parseConsentForm(body);
  // Validates the selection against the catalog (throws on unknown/empty).
  const granted = buildConsentScopes(selection);
  const policy = buildConsentPolicy({ projectPublicId: projectId, selection });

  const scopes = [
    ...granted,
    MCP_ACCESS_SCOPE,
    `${PROJECT_SCOPE_PREFIX}${projectId}`,
  ];

  const consentId = randomUUID();
  putConsentSession({ id: consentId, subject: ctx.authUser.publicId, scopes });
  ctx.cookies.set(CONSENT_COOKIE, consentId, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 10 * 60 * 1000,
  });

  log(
    'decision: user=%s project=%s scopes=%d',
    ctx.authUser.publicId,
    projectId,
    scopes.length
  );

  const oauthParams = pickOauthParams(body);

  // If this decision is part of an OAuth authorize flow, bounce back to the
  // authorization server so it can approve using the consent cookie.
  if (oauthParams.client_id && oauthParams.redirect_uri) {
    const params = new URLSearchParams(oauthParams);
    ctx.status = 302;
    ctx.redirect(`${AUTHORIZE_PATH}?${params.toString()}`);
    return;
  }

  // Standalone use (no OAuth flow): return the resolved grant.
  ctx.status = 200;
  ctx.body = { project_id: projectId, scopes: granted, policy };
});

export { oauthConsentPageRouter };
