import type { Context, Next } from '@ttoss/http-server';

// Koa's unmatched-path 404 and `allowedMethods()`'s 405/501 set a status
// without throwing, so they bypass `errorLogger`; rethrown here, they leave as
// the JSON error envelope and keep the headers already set (`Allow`).
const unansweredApiRequestMiddleware = async (ctx: Context, next: Next) => {
  await next();

  if (!ctx.path.startsWith('/api/') || ctx.status < 400 || ctx.body != null) {
    return;
  }

  if (ctx.status === 404) {
    ctx.throw(404, `No route matches ${ctx.method} ${ctx.path}`);
  }

  // `501` is the caller's unknown method, not a server fault: its reason is safe.
  ctx.throw(ctx.status, { expose: true });
};

export { unansweredApiRequestMiddleware };
