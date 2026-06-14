import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { addHealthCheck, App, bodyParser, cors } from '@ttoss/http-server';

import type { Context } from './Context';
import { initializeDispatcher } from './lib/webhookDispatcher';
import { setupMcpMiddleware } from './mcp/server';
import { authMiddleware } from './middleware/auth';
import { errorLoggerMiddleware } from './middleware/errorLogger';
import { oauthConsentPageRouter } from './oauth/consentPage';
import { oauthAuthorizationServer } from './oauth/server';
import { restRouter } from './rest/router';

const app = new App();

addHealthCheck({ app });

initializeDispatcher();

app.use(errorLoggerMiddleware);
app.use(cors());
app.use(bodyParser());
app.use(authMiddleware);

// OAuth 2.1 authorization server (issuer side): /authorize, /token, /register,
// and discovery metadata. Public — the routes do their own validation.
app.use(oauthAuthorizationServer.routes());

// Consent screen (login is handled by the app via the user's bearer token).
app.use(oauthConsentPageRouter.routes());
app.use(oauthConsentPageRouter.allowedMethods());

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
