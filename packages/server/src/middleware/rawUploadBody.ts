import type { Context } from '../Context';

type Next = () => Promise<void>;

const RAW_UPLOAD_PATH = /^\/api\/v1\/files\/upload\/[^/]+$/;

/**
 * A raw-body upload's body is the file: the route streams it to storage, so
 * the body parser must not read it first (it would buffer a JSON or text file
 * whole and hand the route an empty stream).
 */
export const rawUploadBodyMiddleware = (ctx: Context, next: Next) => {
  if (ctx.method === 'PUT' && RAW_UPLOAD_PATH.test(ctx.path)) {
    ctx.disableBodyParser = true;
  }
  return next();
};
