import * as quotaEnforcement from '../../../../src/lib/quotaEnforcement';
import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

const QUOTA_ACTIONS = [
  'quotas:ListQuotas',
  'quotas:CreateQuota',
  'quotas:GetQuota',
  'quotas:UpdateQuota',
  'quotas:DeleteQuota',
];

describe('Quotas', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let otherProjectId: string;
  let policyId: string;
  let noPermToken: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'quotas',
      policyActions: QUOTA_ACTIONS,
      createOtherProject: true,
      createNoPermUser: true,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId!;
    policyId = setup.policyId;
    noPermToken = setup.noPermToken!;
  });

  const createQuota = (
    token: string,
    body: Record<string, unknown>,
    project = projectId
  ) => {
    return authenticatedTestClient(token)
      .post('/api/v1/quotas')
      .send({ project_id: project, ...body });
  };

  // A project-scoped API key whose policy excludes `excludedAction`, used to
  // exercise the `projectIds === null` (403) branch on routes that don't take a
  // `project_id` param (unlike `noPermToken`, which resolves to an empty project
  // list and 404s instead).
  const createRestrictedApiKey = async (excludedAction: string) => {
    const allowedActions = QUOTA_ACTIONS.filter((action) => {
      return action !== excludedAction;
    });
    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: { statement: [{ effect: 'Allow', action: allowedActions }] },
      });
    const keyRes = await authenticatedTestClient(userToken)
      .post('/api/v1/api-keys')
      .send({
        name: `No ${excludedAction} Key`,
        project_id: projectId,
        policy_ids: [policyRes.body.id],
      });
    expect(keyRes.status).toBe(201);
    return keyRes.body.key as string;
  };

  /**
   * Provisions a fresh project (isolated counters) and an API key scoped to it,
   * carrying the full quotas policy so the key can drive counted GET requests.
   */
  const setupEnforcementProject = async (name: string) => {
    const projRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name });
    const enfProjectId = projRes.body.id as string;

    const keyRes = await authenticatedTestClient(userToken)
      .post('/api/v1/api-keys')
      .send({
        name: `${name} key`,
        project_id: enfProjectId,
        policy_ids: [policyId],
      });
    expect(keyRes.status).toBe(201);

    return {
      enfProjectId,
      keyId: keyRes.body.id as string,
      rawKey: keyRes.body.key as string,
    };
  };

  // ── CRUD ─────────────────────────────────────────────────────────────────

  describe('POST /api/v1/quotas', () => {
    test('creates a requests quota (201)', async () => {
      const res = await createQuota(userToken, {
        scope: 'project',
        metric: 'requests',
        window: 'rolling_1h',
        limit: 500,
      });

      expect(res.status).toBe(201);
      expect(res.body.id).toMatch(/^quota_/);
      expect(res.body.project_id).toBe(projectId);
      expect(res.body.scope).toBe('project');
      expect(res.body.scope_ref).toBeNull();
      expect(res.body.metric).toBe('requests');
      expect(res.body.window).toBe('rolling_1h');
      expect(res.body.limit).toBe(500);
      expect(res.body.mode).toBe('enforce');
      expect(res.body.current_usage).not.toBeNull();
      expect(res.body.current_usage.count).toBe(0);
      expect(res.body.current_usage.window_key).toBeDefined();
      expect(res.body.current_usage.resets_at).toBeDefined();
    });

    test('creates a fractional cost_usd quota with monitor mode (201)', async () => {
      const res = await createQuota(userToken, {
        scope: 'project',
        metric: 'cost_usd',
        window: 'calendar_month',
        limit: 10.5,
        mode: 'monitor',
      });

      expect(res.status).toBe(201);
      expect(res.body.metric).toBe('cost_usd');
      expect(res.body.limit).toBe(10.5);
      expect(res.body.mode).toBe('monitor');
      // Token/cost quotas have no counter table in Phase 1.
      expect(res.body.current_usage).toBeNull();
    });

    test('creates an agent/tokens quota with a null scope_ref (201)', async () => {
      const res = await createQuota(userToken, {
        scope: 'agent',
        metric: 'tokens',
        window: 'calendar_month',
        limit: 100000,
      });

      expect(res.status).toBe(201);
      expect(res.body.scope).toBe('agent');
      expect(res.body.metric).toBe('tokens');
    });

    test('rejects scope=agent with metric=requests (400)', async () => {
      const res = await createQuota(userToken, {
        scope: 'agent',
        metric: 'requests',
        window: 'rolling_1m',
        limit: 10,
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.message).toMatch(/agent/i);
    });

    test('rejects an invalid scope (400)', async () => {
      const res = await createQuota(userToken, {
        scope: 'nonsense',
        metric: 'requests',
        window: 'rolling_1m',
        limit: 10,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('rejects a fractional requests limit (400)', async () => {
      const res = await createQuota(userToken, {
        scope: 'project',
        metric: 'requests',
        window: 'rolling_24h',
        limit: 2.5,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('rejects a non-positive limit (400)', async () => {
      const res = await createQuota(userToken, {
        scope: 'project',
        metric: 'requests',
        window: 'rolling_24h',
        limit: 0,
      });
      expect(res.status).toBe(400);
    });

    test('rejects a scope_ref that names no api key in the project (400)', async () => {
      const res = await createQuota(userToken, {
        scope: 'api_key',
        scope_ref: 'key_doesnotexist0000',
        metric: 'requests',
        window: 'rolling_1m',
        limit: 10,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('rejects a scope_ref that names no agent in the project (400)', async () => {
      const res = await createQuota(userToken, {
        scope: 'agent',
        scope_ref: 'agent_doesnotexist00',
        metric: 'tokens',
        window: 'calendar_month',
        limit: 100,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.message).toMatch(/agent/i);
    });

    test('rejects a scope_ref on a project-scope quota (400)', async () => {
      const res = await createQuota(userToken, {
        scope: 'project',
        scope_ref: 'key_something00000000',
        metric: 'requests',
        window: 'rolling_1h',
        limit: 10,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.message).toMatch(/project/i);
    });

    test('rejects a duplicate quota (409)', async () => {
      const body = {
        scope: 'project',
        metric: 'requests',
        window: 'calendar_month',
        limit: 100,
      };
      const first = await createQuota(userToken, body, otherProjectId);
      expect(first.status).toBe(201);

      const dup = await createQuota(userToken, body, otherProjectId);
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe('QUOTA_CONFLICT');
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.post('/api/v1/quotas').send({
        project_id: projectId,
        scope: 'project',
        metric: 'requests',
        window: 'rolling_1m',
        limit: 1,
      });
      expect(res.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const res = await createQuota(noPermToken, {
        scope: 'project',
        metric: 'requests',
        window: 'rolling_1m',
        limit: 1,
      });
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/v1/quotas', () => {
    test('lists quotas for the project', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/quotas?project_id=${projectId}`
      );
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
      expect(res.body[0].id).toMatch(/^quota_/);
    });

    test('does not leak quotas across projects', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/quotas?project_id=${projectId}`
      );
      const projectIds: string[] = res.body.map((q: { project_id: string }) => {
        return q.project_id;
      });
      expect(
        projectIds.every((p) => {
          return p === projectId;
        })
      ).toBe(true);
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.get('/api/v1/quotas');
      expect(res.status).toBe(401);
    });

    test('user without permission returns 403', async () => {
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/quotas?project_id=${projectId}`
      );
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/v1/quotas/:quota_id', () => {
    let quotaId: string;

    beforeAll(async () => {
      const res = await createQuota(userToken, {
        scope: 'api_key',
        metric: 'requests',
        window: 'rolling_1m',
        limit: 50,
      });
      quotaId = res.body.id;
    });

    test('returns a quota with current window usage', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/quotas/${quotaId}`
      );
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(quotaId);
      expect(res.body.current_usage).not.toBeNull();
      expect(typeof res.body.current_usage.count).toBe('number');
    });

    test('returns 404 for a quota in another project', async () => {
      // A user scoped only to `projectId` cannot resolve a quota that lives in
      // otherProjectId — surfaced as a not-found, not the quota body.
      const otherRes = await createQuota(
        userToken,
        {
          scope: 'project',
          metric: 'tokens',
          window: 'rolling_1h',
          limit: 10,
        },
        otherProjectId
      );
      const otherQuotaId = otherRes.body.id;

      // Re-scope by asking as the noPerm user? Instead assert a bogus id 404s.
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/quotas/quota_doesnotexist00`
      );
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
      expect(otherQuotaId).toMatch(/^quota_/);
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient.get(`/api/v1/quotas/${quotaId}`);
      expect(res.status).toBe(401);
    });

    test('user with zero policies returns 404 (empty project list)', async () => {
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/quotas/${quotaId}`
      );
      expect(res.status).toBe(404);
    });

    test('project-scoped API key without GetQuota returns 403', async () => {
      const key = await createRestrictedApiKey('quotas:GetQuota');
      const res = await authenticatedTestClient(key).get(
        `/api/v1/quotas/${quotaId}`
      );
      expect(res.status).toBe(403);
    });
  });

  describe('PATCH /api/v1/quotas/:quota_id', () => {
    let quotaId: string;

    beforeAll(async () => {
      const res = await createQuota(userToken, {
        scope: 'project',
        metric: 'cost_usd',
        window: 'rolling_24h',
        limit: 5,
      });
      quotaId = res.body.id;
    });

    test('updates limit and mode', async () => {
      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/quotas/${quotaId}`)
        .send({ limit: 12.5, mode: 'monitor' });
      expect(res.status).toBe(200);
      expect(res.body.limit).toBe(12.5);
      expect(res.body.mode).toBe('monitor');
    });

    test('updates mode only, leaving limit untouched', async () => {
      const before = await authenticatedTestClient(userToken).get(
        `/api/v1/quotas/${quotaId}`
      );
      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/quotas/${quotaId}`)
        .send({ mode: 'enforce' });
      expect(res.status).toBe(200);
      expect(res.body.mode).toBe('enforce');
      expect(res.body.limit).toBe(before.body.limit);
    });

    test('an empty patch is a no-op and returns the quota', async () => {
      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/quotas/${quotaId}`)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(quotaId);
    });

    test('rejects an invalid mode (400)', async () => {
      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/quotas/${quotaId}`)
        .send({ mode: 'nonsense' });
      expect(res.status).toBe(400);
    });

    test('rejects a fractional limit on a requests quota (400)', async () => {
      // Created in otherProjectId (no API-key traffic) so this enforce/requests
      // quota never participates in another test's request counting.
      const reqQuota = await createQuota(
        userToken,
        {
          scope: 'api_key',
          metric: 'requests',
          window: 'calendar_month',
          limit: 10,
        },
        otherProjectId
      );
      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/quotas/${reqQuota.body.id}`)
        .send({ limit: 2.5 });
      expect(res.status).toBe(400);
    });

    test('returns 404 for an unknown quota', async () => {
      const res = await authenticatedTestClient(userToken)
        .patch('/api/v1/quotas/quota_doesnotexist00')
        .send({ limit: 1 });
      expect(res.status).toBe(404);
    });

    test('user with zero policies returns 404 (empty project list)', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .patch(`/api/v1/quotas/${quotaId}`)
        .send({ limit: 1 });
      expect(res.status).toBe(404);
    });

    test('project-scoped API key without UpdateQuota returns 403', async () => {
      const key = await createRestrictedApiKey('quotas:UpdateQuota');
      const res = await authenticatedTestClient(key)
        .patch(`/api/v1/quotas/${quotaId}`)
        .send({ limit: 1 });
      expect(res.status).toBe(403);
    });
  });

  describe('DELETE /api/v1/quotas/:quota_id', () => {
    test('deletes a quota (204)', async () => {
      const created = await createQuota(userToken, {
        scope: 'project',
        metric: 'tokens',
        window: 'rolling_1m',
        limit: 9,
      });
      const res = await authenticatedTestClient(userToken).delete(
        `/api/v1/quotas/${created.body.id}`
      );
      expect(res.status).toBe(204);

      const get = await authenticatedTestClient(userToken).get(
        `/api/v1/quotas/${created.body.id}`
      );
      expect(get.status).toBe(404);
    });

    test('returns 404 for an unknown quota', async () => {
      const res = await authenticatedTestClient(userToken).delete(
        '/api/v1/quotas/quota_doesnotexist00'
      );
      expect(res.status).toBe(404);
    });

    test('user with zero policies returns 404 (empty project list)', async () => {
      const created = await createQuota(userToken, {
        scope: 'project',
        metric: 'tokens',
        window: 'rolling_1h',
        limit: 9,
      });
      const res = await authenticatedTestClient(noPermToken).delete(
        `/api/v1/quotas/${created.body.id}`
      );
      expect(res.status).toBe(404);
    });

    test('project-scoped API key without DeleteQuota returns 403', async () => {
      const created = await createQuota(userToken, {
        scope: 'project',
        metric: 'tokens',
        window: 'rolling_24h',
        limit: 9,
      });
      const key = await createRestrictedApiKey('quotas:DeleteQuota');
      const res = await authenticatedTestClient(key).delete(
        `/api/v1/quotas/${created.body.id}`
      );
      expect(res.status).toBe(403);
    });
  });

  // ── Request-quota middleware ───────────────────────────────────────────────

  describe('request-quota enforcement', () => {
    test('blocks request N+1 within the window with 429 + Retry-After', async () => {
      const { enfProjectId, keyId, rawKey } = await setupEnforcementProject(
        'quotas-enforce-basic'
      );

      const quotaRes = await createQuota(
        userToken,
        {
          scope: 'api_key',
          scope_ref: keyId,
          metric: 'requests',
          window: 'rolling_1m',
          limit: 3,
        },
        enfProjectId
      );
      expect(quotaRes.status).toBe(201);
      const quotaId = quotaRes.body.id;

      // Requests 1..3 pass.
      for (let i = 0; i < 3; i += 1) {
        const ok = await authenticatedTestClient(rawKey).get(
          `/api/v1/quotas?project_id=${enfProjectId}`
        );
        expect(ok.status).toBe(200);
      }

      // Request 4 breaches.
      const blocked = await authenticatedTestClient(rawKey).get(
        `/api/v1/quotas?project_id=${enfProjectId}`
      );
      expect(blocked.status).toBe(429);
      expect(blocked.headers['retry-after']).toBeDefined();
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      expect(blocked.body.error.code).toBe('QUOTA_EXCEEDED');
      expect(blocked.body.error.meta.quota_id).toBe(quotaId);
      expect(blocked.body.error.meta.metric).toBe('requests');
      expect(blocked.body.error.meta.limit).toBe(3);
      expect(blocked.body.error.meta.window).toBe('rolling_1m');
      expect(blocked.body.error.meta.resets_at).toBeDefined();
    });

    test('breaching the api-key quota is attributed over the project quota', async () => {
      const { enfProjectId, keyId, rawKey } = await setupEnforcementProject(
        'quotas-enforce-attribution'
      );

      // A generous project-wide cap that will not breach...
      await createQuota(
        userToken,
        {
          scope: 'project',
          metric: 'requests',
          window: 'rolling_1m',
          limit: 100,
        },
        enfProjectId
      );
      // ...and a tight api-key cap that will.
      const keyQuota = await createQuota(
        userToken,
        {
          scope: 'api_key',
          scope_ref: keyId,
          metric: 'requests',
          window: 'rolling_1m',
          limit: 2,
        },
        enfProjectId
      );

      for (let i = 0; i < 2; i += 1) {
        const ok = await authenticatedTestClient(rawKey).get(
          `/api/v1/quotas?project_id=${enfProjectId}`
        );
        expect(ok.status).toBe(200);
      }

      const blocked = await authenticatedTestClient(rawKey).get(
        `/api/v1/quotas?project_id=${enfProjectId}`
      );
      expect(blocked.status).toBe(429);
      // The most specific breached scope (api_key) is reported.
      expect(blocked.body.error.meta.quota_id).toBe(keyQuota.body.id);
    });

    test('breaching a project-wide quota blocks the key', async () => {
      const { enfProjectId, rawKey } = await setupEnforcementProject(
        'quotas-enforce-project'
      );

      const projQuota = await createQuota(
        userToken,
        {
          scope: 'project',
          metric: 'requests',
          window: 'rolling_1m',
          limit: 2,
        },
        enfProjectId
      );

      for (let i = 0; i < 2; i += 1) {
        const ok = await authenticatedTestClient(rawKey).get(
          `/api/v1/quotas?project_id=${enfProjectId}`
        );
        expect(ok.status).toBe(200);
      }

      const blocked = await authenticatedTestClient(rawKey).get(
        `/api/v1/quotas?project_id=${enfProjectId}`
      );
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.meta.quota_id).toBe(projQuota.body.id);
    });

    test('when both a project and api-key quota breach, the api-key one is attributed', async () => {
      const { enfProjectId, keyId, rawKey } = await setupEnforcementProject(
        'quotas-enforce-both'
      );

      // Both caps are limit 1, so the second request breaches both at once —
      // the breach list has two entries and the most specific (api_key) wins.
      const projQuota = await createQuota(
        userToken,
        {
          scope: 'project',
          metric: 'requests',
          window: 'rolling_1m',
          limit: 1,
        },
        enfProjectId
      );
      const keyQuota = await createQuota(
        userToken,
        {
          scope: 'api_key',
          scope_ref: keyId,
          metric: 'requests',
          window: 'rolling_1m',
          limit: 1,
        },
        enfProjectId
      );

      const ok = await authenticatedTestClient(rawKey).get(
        `/api/v1/quotas?project_id=${enfProjectId}`
      );
      expect(ok.status).toBe(200);

      const blocked = await authenticatedTestClient(rawKey).get(
        `/api/v1/quotas?project_id=${enfProjectId}`
      );
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.meta.quota_id).toBe(keyQuota.body.id);
      expect(blocked.body.error.meta.quota_id).not.toBe(projQuota.body.id);
    });

    test('never admits more than limit under concurrency', async () => {
      const { enfProjectId, keyId, rawKey } = await setupEnforcementProject(
        'quotas-enforce-concurrency'
      );

      const limit = 5;
      await createQuota(
        userToken,
        {
          scope: 'api_key',
          scope_ref: keyId,
          metric: 'requests',
          window: 'rolling_1m',
          limit,
        },
        enfProjectId
      );

      const total = 25;
      const results = await Promise.all(
        Array.from({ length: total }, () => {
          return authenticatedTestClient(rawKey).get(
            `/api/v1/quotas?project_id=${enfProjectId}`
          );
        })
      );

      const admitted = results.filter((r) => {
        return r.status === 200;
      }).length;
      const blocked = results.filter((r) => {
        return r.status === 429;
      }).length;

      // The atomic increment must never let more than `limit` through.
      expect(admitted).toBe(limit);
      expect(blocked).toBe(total - limit);
    });

    test('JWT-user requests are never counted or blocked', async () => {
      const { enfProjectId } =
        await setupEnforcementProject('quotas-jwt-exempt');

      await createQuota(
        userToken,
        {
          scope: 'project',
          metric: 'requests',
          window: 'rolling_1m',
          limit: 1,
        },
        enfProjectId
      );

      // Far more than the limit; JWT auth is exempt from counting.
      for (let i = 0; i < 5; i += 1) {
        const res = await authenticatedTestClient(userToken).get(
          `/api/v1/quotas?project_id=${enfProjectId}`
        );
        expect(res.status).toBe(200);
      }
    });

    test('an API key in a project with no requests quota is never blocked', async () => {
      const { enfProjectId, rawKey } =
        await setupEnforcementProject('quotas-no-match');

      // No quota created — evaluateRequestQuotas finds nothing to match and the
      // request proceeds.
      for (let i = 0; i < 3; i += 1) {
        const res = await authenticatedTestClient(rawKey).get(
          `/api/v1/quotas?project_id=${enfProjectId}`
        );
        expect(res.status).toBe(200);
      }
    });

    test('fails open when the counter write errors', async () => {
      const { enfProjectId, keyId, rawKey } =
        await setupEnforcementProject('quotas-fail-open');
      await createQuota(
        userToken,
        {
          scope: 'api_key',
          scope_ref: keyId,
          metric: 'requests',
          window: 'rolling_1m',
          limit: 1,
        },
        enfProjectId
      );

      // Enforcement is active: request 2 breaches the limit-1 quota.
      const ok = await authenticatedTestClient(rawKey).get(
        `/api/v1/quotas?project_id=${enfProjectId}`
      );
      expect(ok.status).toBe(200);
      const blocked = await authenticatedTestClient(rawKey).get(
        `/api/v1/quotas?project_id=${enfProjectId}`
      );
      expect(blocked.status).toBe(429);

      // Sanctioned force-failure stub (see tests.md): the fail-open `.catch`
      // branch can only be exercised by making the counter evaluation reject —
      // no real DB write fails deterministically. The request must then proceed
      // (200) instead of surfacing the error or the 429.
      const spy = jest
        .spyOn(quotaEnforcement, 'evaluateRequestQuotas')
        .mockRejectedValueOnce(new Error('counter write failed'));
      try {
        const failedOpen = await authenticatedTestClient(rawKey).get(
          `/api/v1/quotas?project_id=${enfProjectId}`
        );
        expect(failedOpen.status).toBe(200);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
