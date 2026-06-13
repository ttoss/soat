import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { addHealthCheck, App, bodyParser, cors } from '@ttoss/http-server';

import type { Context } from './Context';
import { initializeDispatcher } from './lib/webhookDispatcher';
import { setupMcpMiddleware } from './mcp/server';
import { authMiddleware } from './middleware/auth';
import { errorLoggerMiddleware } from './middleware/errorLogger';
import { restRouter } from './rest/router';

const app = new App();

addHealthCheck({ app });

initializeDispatcher();

app.use(errorLoggerMiddleware);
app.use(cors());
app.use(bodyParser());
app.use(authMiddleware);

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

const APP_DIST =
  process.env.APP_DIST_PATH ??
  join(fileURLToPath(new URL('.', import.meta.url)), '../../app/dist');

app.use(async (ctx: Context, next: () => Promise<void>) => {
  if (!ctx.path.startsWith('/app')) {
    return next();
  }

  if (!existsSync(APP_DIST)) {
    return next();
  }

  const subPath = ctx.path.slice('/app'.length) || '/';
  const safeSub =
    subPath.replace(/\.\./g, '').replace(/^\/+/, '') || 'index.html';
  const candidate = resolve(join(APP_DIST, safeSub));
  const root = resolve(APP_DIST);

  if (!candidate.startsWith(root)) {
    ctx.status = 403;
    return;
  }

  const servePath =
    !existsSync(candidate) || statSync(candidate).isDirectory()
      ? join(APP_DIST, 'index.html')
      : candidate;

  if (!existsSync(servePath)) {
    return next();
  }

  ctx.type = MIME_TYPES[extname(servePath)] ?? 'application/octet-stream';
  ctx.body = createReadStream(servePath);
});

export { app };
