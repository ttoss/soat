import { models } from '@soat/postgresdb';
import { App, Router } from '@ttoss/http-server';
import { APICallError } from 'ai';
import { AppError } from 'src/AppError';
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

    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {
        return undefined;
      });

    const response = await request(app.callback())
      .get('/boom')
      .set('User-Agent', 'jest-test-agent');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal Server Error' });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Request failed:',
      expect.objectContaining({
        method: 'GET',
        path: '/boom',
        status: 500,
        userAgent: 'jest-test-agent',
      })
    );

    consoleErrorSpy.mockRestore();
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

    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {
        return undefined;
      });

    const response = await request(app.callback())
      .get('/boom')
      .set('User-Agent', 'jest-test-agent');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal Server Error' });
    expect(consoleErrorSpy).not.toHaveBeenCalledWith(
      'Request failed:',
      expect.any(Object)
    );

    consoleErrorSpy.mockRestore();
  });

  test('returns AppError message and logs the cause', async () => {
    delete process.env.SOAT_ERROR_LOGS_ENABLED;

    const app = new App();
    const router = new Router();

    app.use(errorLoggerMiddleware);

    const cause = new Error('DB connection failed');

    router.get('/boom', async () => {
      throw new AppError({ message: 'Error creating resource', cause });
    });

    app.use(router.routes());

    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {
        return undefined;
      });

    const response = await request(app.callback())
      .get('/boom')
      .set('User-Agent', 'jest-test-agent');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Error creating resource' });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Request failed:',
      expect.objectContaining({
        error: expect.stringContaining('DB connection failed'),
      })
    );

    consoleErrorSpy.mockRestore();
  });

  test('logs APICallError fields (url, statusCode, responseBody) when cause is APICallError', async () => {
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
      throw new AppError({
        message: 'Error generating response',
        cause: apiCallError,
      });
    });

    app.use(router.routes());

    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {
        return undefined;
      });

    const response = await request(app.callback()).get('/boom');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Error generating response' });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Request failed:',
      expect.objectContaining({
        url: 'https://api.openai.com/v1/chat/completions',
        statusCode: 429,
        responseBody: '{"error":"rate_limit_exceeded"}',
      })
    );

    consoleErrorSpy.mockRestore();
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

    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {
        return undefined;
      });

    const response = await request(app.callback()).get('/db-boom');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal Server Error' });

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Request failed:',
      expect.objectContaining({
        sql: expect.stringContaining('SELECT 1::integer / 0'),
        dbError: expect.objectContaining({
          // PostgreSQL error code for division_by_zero
          code: '22012',
        }),
      })
    );

    consoleErrorSpy.mockRestore();
  });
});
