import type { Context } from '../Context';
import { DomainError } from '../errors';

type Next = () => Promise<void>;

const MAX_HOOK_BODY_BYTES = 1024 * 1024; // 1 MiB

/**
 * For public inbound hook paths (`/hooks/*`), takes ownership of the raw request
 * body so the endpoint can verify the HMAC signature over the exact bytes the
 * caller signed. Disables the JSON body parser for these paths (the endpoint
 * parses the raw body itself, giving precise control over the invalid-JSON
 * response), and enforces the 1 MiB size cap. Non-hook paths pass through
 * untouched to the normal body parser.
 */
export const hookRawBodyMiddleware = async (ctx: Context, next: Next) => {
  if (!ctx.path.startsWith('/hooks/')) {
    return next();
  }

  ctx.disableBodyParser = true;

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of ctx.req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_HOOK_BODY_BYTES) {
      throw new DomainError(
        'HOOK_PAYLOAD_TOO_LARGE',
        'Inbound hook body exceeds the 1 MiB limit.'
      );
    }
    chunks.push(chunk);
  }

  ctx.hookRawBody = Buffer.concat(chunks).toString('utf8');
  return next();
};
