import { Router } from '@ttoss/http-server';
import type { Context } from 'src/Context';
import { toolAssertionJwks } from 'src/lib/toolAssertion';

/**
 * The public half of the key tool assertions are signed with, for a tool
 * server to verify them (`lib/toolAssertion.ts`). Outside `/api/v1`: no
 * bearer, and not part of the SDK/CLI/MCP surface.
 */
const toolAssertionKeysRouter = new Router<Context>();

export const TOOL_ASSERTION_JWKS_PATH = '/.well-known/tool-assertion-jwks.json';

toolAssertionKeysRouter.get(TOOL_ASSERTION_JWKS_PATH, (ctx: Context) => {
  // Short enough that a rotated key reaches a caching verifier within minutes.
  ctx.set('Cache-Control', 'public, max-age=300');
  ctx.body = toolAssertionJwks();
});

export { toolAssertionKeysRouter };
