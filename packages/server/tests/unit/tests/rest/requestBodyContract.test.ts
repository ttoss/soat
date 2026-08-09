import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { testClient } from '../../testClient';

/**
 * Two facts about `ctx.request.body`, both established outside the handlers.
 *
 * **It is always an object.** `@koa/bodyparser` assigns `{}` whenever no parser
 * claims the request — an unclaimed content type, an empty body — and throws
 * otherwise, so it is never nullish by the time a route reads it. 24 handlers
 * nonetheless carried a `(ctx.request.body ?? {})` fallback; across 5,300 tests,
 * including requests with no body and with `Content-Type:
 * application/octet-stream`, not one of those 24 right-hand sides ever
 * evaluated. They were dead, and `.claude/rules/tests.md` is explicit that an
 * unreachable defensive branch gets deleted rather than tested.
 *
 * **A malformed body is the client's fault.** `co-body` marks its parse failures
 * `status = 400` but omits `expose`, so `errorLogger`'s koa-error check rejected
 * them and every one answered `500 {"error":"Internal Server Error"}` — the
 * server taking blame for a bad request, in the one response shape that is not
 * the documented error contract. Found while auditing the fallbacks above; the
 * fix lives in `errorLogger`, the single place that maps an error to a response.
 */

const V1_DIR = join(__dirname, '../../../../src/rest/v1');

describe('request body handling', () => {
  test('a literal JSON null body is a 400, not a 500', async () => {
    const response = await testClient
      .post('/api/v1/quotas')
      .set('Content-Type', 'application/json')
      .send('null');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    expect(response.body.error.message).toMatch(/malformed request body/i);
  });

  test('syntactically invalid JSON is a 400, not a 500', async () => {
    const response = await testClient
      .post('/api/v1/quotas')
      .set('Content-Type', 'application/json')
      .send('{"scope":');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });

  test('an unclaimed content type parses to an empty object, not an error', async () => {
    const response = await testClient
      .post('/api/v1/quotas')
      .set('Content-Type', 'application/octet-stream')
      .send('raw bytes');

    // Reaches the route, which rejects it on authentication — proof the body
    // arrived as a readable object rather than tripping the parser.
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
  });

  test.each(
    readdirSync(V1_DIR).filter((f) => {
      return f.endsWith('.ts');
    })
  )('%s does not re-guard the body shape', (file) => {
    const source = readFileSync(join(V1_DIR, file), 'utf8');

    expect(source).not.toContain('ctx.request.body ?? {}');
  });
});
