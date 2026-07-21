import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { addHealthCheck, App, bodyParser, cors } from '@ttoss/http-server';

import type { Context } from './Context';
import { initializeDispatcher } from './lib/webhookDispatcher';
import { setupMcpMiddleware } from './mcp/server';
import { auditMiddleware } from './middleware/audit';
import { authMiddleware } from './middleware/auth';
import { errorLoggerMiddleware } from './middleware/errorLogger';
import { hookRawBodyMiddleware } from './middleware/hookRawBody';
import { quotaMiddleware } from './middleware/quota';
import { requestIdMiddleware } from './middleware/requestId';
import { oauthAuthorizationServer } from './oauth/server';
import { hooksRouter } from './rest/hooks';
import { restRouter } from './rest/router';

const app = new App();

addHealthCheck({ app });

initializeDispatcher();

app.use(errorLoggerMiddleware);
app.use(cors());
// Assign a per-request correlation id and echo it as X-Request-Id before any
// downstream middleware runs, so every response (including errors) carries it
// and the audit log can record it.
app.use(requestIdMiddleware);
// Capture the raw body for public inbound hook paths before the JSON body
// parser runs, so signatures can be verified over the exact bytes.
app.use(hookRawBodyMiddleware);
app.use(bodyParser());
app.use(authMiddleware);
// Request-quota enforcement: after auth (counted identity is known), before the
// route handlers so no handler work is wasted on a blocked request. Counts
// API-key-authenticated /api/v1 requests only; fails open on DB error.
app.use(quotaMiddleware);
// Audit-log write hook: after auth (wraps the attached isAllowed) and wrapping
// the route handlers, it records one entry per mutating /api/v1 request
// post-commit through a fire-and-forget queue.
app.use(auditMiddleware);

// OAuth 2.1 authorization server (issuer side): /authorize, /token, /register,
// and discovery metadata. Public — the routes do their own validation. The
// consent UI itself lives in the app (SPA); /authorize redirects to it.
app.use(oauthAuthorizationServer.routes());

// Public inbound hook receiver — outside /api/v1: HMAC-authenticated, no case
// transform, excluded from the generated SDK/CLI/MCP surface.
app.use(hooksRouter.routes());

app.use(restRouter.routes());
app.use(restRouter.allowedMethods());

setupMcpMiddleware(app);

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain',
};

const DEFAULT_APP_DIST = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../app/dist'
);

const resolveServePath = (
  appDist: string,
  urlPath: string
): string | null | undefined => {
  const subPath = urlPath.slice('/app'.length) || '/';
  const safeSub =
    subPath.replace(/\.\./g, '').replace(/^\/+/, '') || 'index.html';
  const candidate = resolve(join(appDist, safeSub));
  const root = resolve(appDist);

  if (!candidate.startsWith(root)) {
    return null;
  }

  const resolved =
    !existsSync(candidate) || statSync(candidate).isDirectory()
      ? join(appDist, 'index.html')
      : candidate;

  return existsSync(resolved) ? resolved : undefined;
};

app.use(async (ctx: Context, next: () => Promise<void>) => {
  if (ctx.path === '/') {
    ctx.redirect('/app');
    return;
  }

  if (!ctx.path.startsWith('/app')) {
    return next();
  }

  const appDist = process.env.APP_DIST_PATH ?? DEFAULT_APP_DIST;

  if (!existsSync(appDist)) {
    return next();
  }

  const servePath = resolveServePath(appDist, ctx.path);

  if (servePath === null) {
    ctx.status = 403;
    return;
  }

  if (!servePath) {
    return next();
  }

  ctx.type = MIME_TYPES[extname(servePath)] ?? 'application/octet-stream';
  ctx.body = createReadStream(servePath);
});

export { app };
