import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { models } from '@soat/postgresdb';
import { App, Router } from '@ttoss/http-server';
import { recordClaimLatency } from 'src/lib/orchestrationQueueMetrics';
import { errorLoggerMiddleware } from 'src/middleware/errorLogger';
import request from 'supertest';

import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

describe('Secret hygiene', () => {
  let adminToken: string;
  let projectId: string;
  let scopedToken: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'hygiene',
      policyActions: [
        'tools:GetTool',
        'tools:CreateTool',
        'secrets:CreateSecret',
        'orchestrations:GetQueueStats',
      ],
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;

    scopedToken = await createScopedPrincipal({
      adminToken,
      projectId,
      username: 'hygienescoped',
      actions: ['orchestrations:GetQueueStats'],
    });
  });

  describe('error logs', () => {
    const previousErrorLogsEnabled = process.env.SOAT_ERROR_LOGS_ENABLED;
    let logged: string[];
    let consoleError: jest.SpyInstance;

    beforeEach(() => {
      delete process.env.SOAT_ERROR_LOGS_ENABLED;
      logged = [];
      consoleError = jest
        .spyOn(console, 'error')
        .mockImplementation((...parts: unknown[]) => {
          logged.push(
            parts
              .map((part) => {
                return String(part);
              })
              .join(' ')
          );
        });
    });

    afterEach(() => {
      consoleError.mockRestore();
      if (previousErrorLogsEnabled === undefined) {
        delete process.env.SOAT_ERROR_LOGS_ENABLED;
      } else {
        process.env.SOAT_ERROR_LOGS_ENABLED = previousErrorLogsEnabled;
      }
    });

    test('a failed query does not log the values it was bound with', async () => {
      const app = new App();
      const router = new Router();
      app.use(errorLoggerMiddleware);

      router.get('/db-boom', async () => {
        // `bind`, not `replacements`: bind values travel to Postgres as
        // parameters, which is the shape every model write uses and the one
        // the log payload used to carry verbatim.
        await models.Actor.sequelize?.query(
          'SELECT 1::integer / 0 WHERE $1 = $1',
          { bind: ['sk-live-do-not-log-me'] }
        );
      });

      app.use(router.routes());
      const response = await request(app.callback()).get('/db-boom');

      expect(response.status).toBe(500);
      const output = logged.join('\n');
      expect(output).toContain('Request failed');
      expect(output).not.toContain('sk-live-do-not-log-me');
    });
  });

  describe('debug logs', () => {
    /**
     * A source assertion rather than a captured stream: `debug` decides whether
     * to emit when the namespace is enabled at import time, so a test that
     * enables it afterwards observes nothing and passes whatever the code says.
     */
    test('no upload-token log statement carries the token value', () => {
      const source = readFileSync(
        join(__dirname, '../../../../src/lib/uploadTokens.ts'),
        'utf8'
      );
      const logStatements = (source.match(/log\([^;]*\)/g) ?? []).map(
        (statement) => {
          // A fingerprinted argument is the point of the fix, so the hash call
          // and what it wraps are removed before looking for a raw token.
          return statement.replace(/fingerprintToken\([^)]*\)/g, '');
        }
      );

      expect(logStatements.length).toBeGreaterThan(0);
      expect(
        logStatements.filter((statement) => {
          return /args\.token|\.publicId/.test(statement);
        })
      ).toEqual([]);
    });
  });

  describe('GET /api/v1/tools/{tool_id}', () => {
    test('a literal credential in execute.auth is not echoed back', async () => {
      const created = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'sigv4-tool',
          type: 'http',
          execute: {
            url: 'https://example.test/thing',
            method: 'POST',
            auth: {
              type: 'aws_sigv4',
              region: 'us-east-1',
              service: 'execute-api',
              access_key_id: 'AKIAIOSFODNN7EXAMPLE',
              secret_access_key: 'wJalrXUtnFEMI-do-not-echo',
              session_token: 'FwoGZXIvYXdz-do-not-echo',
            },
          },
        });

      expect(created.status).toBe(201);
      expect(JSON.stringify(created.body)).not.toContain('do-not-echo');

      const read = await authenticatedTestClient(adminToken).get(
        `/api/v1/tools/${created.body.id}`
      );

      expect(read.status).toBe(200);
      expect(JSON.stringify(read.body)).not.toContain('do-not-echo');
      expect(read.body.execute.auth.region).toBe('us-east-1');
    });

    test('a credential-shaped header is not echoed, an ordinary one is', async () => {
      const created = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'header-tool',
          type: 'http',
          execute: {
            url: 'https://example.test/thing',
            method: 'POST',
            headers: {
              Authorization: 'Bearer sk-live-do-not-echo',
              'Content-Type': 'application/json',
            },
          },
        });

      expect(created.status).toBe(201);

      const read = await authenticatedTestClient(adminToken).get(
        `/api/v1/tools/${created.body.id}`
      );

      expect(read.status).toBe(200);
      expect(JSON.stringify(read.body)).not.toContain('do-not-echo');
      expect(read.body.execute.headers['Content-Type']).toBe(
        'application/json'
      );
    });

    test('a {{secret:...}} reference stays readable', async () => {
      const secret = await authenticatedTestClient(adminToken)
        .post('/api/v1/secrets')
        .send({
          project_id: projectId,
          name: 'hygiene-key',
          value: 'the-real-value',
        });

      expect(secret.status).toBe(201);

      const created = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: 'ref-tool',
          type: 'http',
          execute: {
            url: 'https://example.test/thing',
            method: 'POST',
            headers: {
              Authorization: `Bearer {{secret:${secret.body.id}}}`,
            },
          },
        });

      expect(created.status).toBe(201);

      const read = await authenticatedTestClient(adminToken).get(
        `/api/v1/tools/${created.body.id}`
      );

      expect(read.status).toBe(200);
      expect(read.body.execute.headers.Authorization).toBe(
        `Bearer {{secret:${secret.body.id}}}`
      );
      expect(JSON.stringify(read.body)).not.toContain('the-real-value');
    });
  });

  describe('GET /api/v1/orchestrations/queue/stats', () => {
    beforeAll(() => {
      // A claim recorded by some other project's worker: the ring is
      // process-wide, so without scoping it reaches every caller.
      recordClaimLatency({ at: Date.now(), latencyMs: 4321 });
    });

    test('a project-scoped principal is not told the platform claim latency', async () => {
      const response = await authenticatedTestClient(scopedToken).get(
        '/api/v1/orchestrations/queue/stats'
      );

      expect(response.status).toBe(200);
      expect(response.body.claim_latency_ms.p50).toBeNull();
      expect(response.body.claim_latency_ms.p95).toBeNull();
      expect(response.body.oldest_queued_age_seconds).toBeNull();
      expect(response.body.queue_depth).toBe(0);
      expect(response.body.claimed_tasks).toBe(0);
    });

    test('an unrestricted principal still gets the platform figures', async () => {
      const response = await authenticatedTestClient(adminToken).get(
        '/api/v1/orchestrations/queue/stats'
      );

      expect(response.status).toBe(200);
      expect(response.body.claim_latency_ms.p50).toBe(4321);
      expect(response.body.claim_latency_ms.p95).toBe(4321);
      expect(typeof response.body.queue_depth).toBe('number');
    });
  });
});
