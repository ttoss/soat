import { App, Router } from '@ttoss/http-server';
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
    expect(response.body).toEqual({ error: 'boom' });
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
    expect(response.body).toEqual({ error: 'boom' });
    expect(consoleErrorSpy).not.toHaveBeenCalledWith(
      'Request failed:',
      expect.any(Object)
    );

    consoleErrorSpy.mockRestore();
  });
});
