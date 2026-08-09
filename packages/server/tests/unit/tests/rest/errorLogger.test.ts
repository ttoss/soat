import { models } from '@soat/postgresdb';
import { App, Router } from '@ttoss/http-server';
import { APICallError } from 'ai';
import { errorLoggerMiddleware } from 'src/middleware/errorLogger';
import request from 'supertest';

describe('errorLogger middleware', () => {
  const previousErrorLogsEnabled = process.env.SOAT_ERROR_LOGS_ENABLED;

  afterEach(() => {
    if (previousErrorLogsEnabled === undefined) {
      delete process.env.SOAT_ERROR_LOGS_ENABLED;
      return;
    }

    process.env.SOAT_ERROR_LOGS_ENABLED = previousErrorLogsEnabled;
  });

  test('logs unhandled errors with request context', async () => {
    delete process.env.SOAT_ERROR_LOGS_ENABLED;

    const app = new App();
    const router = new Router();

    app.use(errorLoggerMiddleware);

    router.get('/boom', async () => {
      throw new Error('boom');
    });

    app.use(router.routes());

    const response = await request(app.callback())
      .get('/boom')
      .set('User-Agent', 'jest-test-agent');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal Server Error' },
    });
  });

  test('does not log unhandled errors when SOAT_ERROR_LOGS_ENABLED is false', async () => {
    process.env.SOAT_ERROR_LOGS_ENABLED = 'false';

    const app = new App();
    const router = new Router();

    app.use(errorLoggerMiddleware);

    router.get('/boom', async () => {
      throw new Error('boom');
    });

    app.use(router.routes());

    const response = await request(app.callback())
      .get('/boom')
      .set('User-Agent', 'jest-test-agent');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal Server Error' },
    });
  });

  test('logs APICallError fields (url, statusCode, responseBody) when error is APICallError', async () => {
    delete process.env.SOAT_ERROR_LOGS_ENABLED;

    const app = new App();
    const router = new Router();

    app.use(errorLoggerMiddleware);

    const apiCallError = new APICallError({
      message: 'Upstream AI failure',
      url: 'https://api.openai.com/v1/chat/completions',
      statusCode: 429,
      responseBody: '{"error":"rate_limit_exceeded"}',
      requestBodyValues: {},
      isRetryable: false,
    });

    router.get('/boom', async () => {
      throw apiCallError;
    });

    app.use(router.routes());

    const response = await request(app.callback()).get('/boom');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal Server Error' },
    });
  });

  test('logs DatabaseError fields (sql, dbError) when a real database error occurs', async () => {
    delete process.env.SOAT_ERROR_LOGS_ENABLED;

    const app = new App();
    const router = new Router();

    app.use(errorLoggerMiddleware);

    router.get('/db-boom', async () => {
      // Trigger a real PostgreSQL division-by-zero error so Sequelize wraps it
      // in a DatabaseError with .sql and .original populated.
      await models.Actor.sequelize?.query('SELECT 1::integer / 0');
    });

    app.use(router.routes());

    const response = await request(app.callback()).get('/db-boom');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal Server Error' },
    });
  });
});

/**
 * The error contract has exactly one shape, with no exceptions.
 *
 * #913 collapsed the 349 hand-written `{ error: "some string" }` bodies onto
 * `{ error: { code, message } }` but left the 500 catch-all as a bare string,
 * so a client still had to test the type of `error` before reading it — the
 * single branch the convergence was supposed to remove. A catch-all is exactly
 * the response a client is least able to special-case, since it is the one that
 * shows up unannounced.
 */
describe('every error response carries the object shape', () => {
  const appAnswering = (thrown: unknown) => {
    const app = new App();
    const router = new Router();

    app.use(errorLoggerMiddleware);
    router.get('/boom', async () => {
      throw thrown;
    });
    app.use(router.routes());

    return request(app.callback()).get('/boom');
  };

  test('a plain Error is INTERNAL_ERROR and forwards no detail', async () => {
    const response = await appAnswering(
      new Error('connection string: postgres://user:hunter2@db/soat')
    );

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('INTERNAL_ERROR');
    expect(response.body.error.message).toBe('Internal Server Error');
    expect(JSON.stringify(response.body)).not.toMatch(/hunter2/);
  });

  test('a thrown non-Error value is INTERNAL_ERROR', async () => {
    const response = await appAnswering('a bare string');

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('INTERNAL_ERROR');
  });

  test('an exposed koa error keeps its status and message under a code', async () => {
    const koaError = Object.assign(new Error('Payload Too Large'), {
      status: 413,
      expose: true,
    });

    const response = await appAnswering(koaError);

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('REQUEST_REJECTED');
    expect(response.body.error.message).toBe('Payload Too Large');
  });

  test('an unexposed koa error reveals nothing beyond its status', async () => {
    const koaError = Object.assign(new Error('internal routing detail'), {
      status: 503,
      expose: false,
    });

    const response = await appAnswering(koaError);

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('INTERNAL_ERROR');
    expect(response.body.error.message).toBe('Internal Server Error');
    expect(JSON.stringify(response.body)).not.toMatch(/routing detail/);
  });
});
