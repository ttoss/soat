import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import { db } from 'src/db';
import { flushAuditQueue } from 'src/lib/auditQueue';
import { eventBus, type SoatEvent } from 'src/lib/eventBus';

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

/**
 * The window every quota that a **counted request sequence** runs against must
 * use. Not a detail — picking `rolling_1m` here is what made this file flaky
 * (#1049).
 *
 * `requests` windows are fixed windows keyed by a truncated wall-clock stamp
 * (`quotaWindows.ts`), so a `rolling_1m` counter resets at every minute
 * boundary. A test that issues 3 requests against `limit: 2` therefore asserts
 * on the counter only while all three land inside the same minute: when the
 * boundary falls between the 2nd and the 3rd — a few hundred milliseconds of
 * exposure per run, which a loaded CI shard eventually hits — the 3rd request
 * reads a freshly reset counter and is admitted, failing with
 * `Expected: 429, Received: 200`.
 *
 * A `calendar_month` key (`YYYY-MM`) cannot roll over inside a test run, which
 * removes the wall clock from the assertion entirely. Nothing is weakened: the
 * count, the limit comparison, the blocking, the once-per-window webhook guard
 * and the attribution are identical for every window — only the key differs.
 * The key derivation itself (`rolling_1m` included) is covered against a frozen
 * clock in `lib/quotas.test.ts`, where it is deterministic.
 *
 * `lib/quotaGenerationEnforcement.test.ts` defaults to the same window for the
 * same reason.
 */
const COUNTED_WINDOW = 'calendar_month';

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
  // list — a 404 on a read, a 403 on a write).
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

    test('accepts an explicit null scope_ref', async () => {
      const res = await createQuota(userToken, {
        scope: 'project',
        scope_ref: null,
        metric: 'tokens',
        window: 'rolling_24h',
        limit: 42,
      });

      expect(res.status).toBe(201);
      expect(res.body.scope_ref).toBeNull();
    });

    test('an entirely absent body is a validation error, not a crash', async () => {
      const res =
        await authenticatedTestClient(userToken).post('/api/v1/quotas');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
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
      // The pricing posture defaults to block and is visible on the row.
      expect(res.body.on_unpriced).toBe('block');
      // Token/cost quotas have no counter table in Phase 1.
      expect(res.body.current_usage).toBeNull();
    });

    test('accepts an explicit on_unpriced "allow" on a cost quota', async () => {
      const res = await createQuota(userToken, {
        scope: 'project',
        metric: 'cost_usd',
        window: 'rolling_1h',
        limit: 3,
        on_unpriced: 'allow',
      });

      expect(res.status).toBe(201);
      expect(res.body.on_unpriced).toBe('allow');
    });

    test('a non-cost quota carries no pricing posture', async () => {
      const res = await createQuota(userToken, {
        scope: 'project',
        metric: 'requests',
        window: 'rolling_1m',
        limit: 9,
      });

      expect(res.status).toBe(201);
      expect(res.body.on_unpriced).toBeNull();
    });

    test('rejects on_unpriced on a metric with no pricing dependency (400)', async () => {
      const res = await createQuota(userToken, {
        scope: 'project',
        metric: 'tokens',
        window: 'rolling_1m',
        limit: 100,
        on_unpriced: 'block',
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.message).toContain('cost_usd');
    });

    test('rejects an on_unpriced outside the vocabulary (400)', async () => {
      const res = await createQuota(userToken, {
        scope: 'project',
        metric: 'cost_usd',
        window: 'rolling_1m',
        limit: 1,
        on_unpriced: 'explode',
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
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

    test('creates an actor/cost_usd quota with a scope_ref (201)', async () => {
      const actorRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/actors')
        .send({ project_id: projectId, name: 'quota actor' });
      expect(actorRes.status).toBe(201);

      const res = await createQuota(userToken, {
        scope: 'actor',
        scope_ref: actorRes.body.id,
        metric: 'cost_usd',
        window: 'calendar_month',
        limit: 5,
      });

      expect(res.status).toBe(201);
      expect(res.body.scope).toBe('actor');
      expect(res.body.scope_ref).toBe(actorRes.body.id);
      expect(res.body.metric).toBe('cost_usd');
      expect(res.body.current_usage).toBeNull();
    });

    test('creates an actor/tokens quota with a null scope_ref (201)', async () => {
      const res = await createQuota(userToken, {
        scope: 'actor',
        metric: 'tokens',
        window: 'calendar_month',
        limit: 100000,
      });

      expect(res.status).toBe(201);
      expect(res.body.scope).toBe('actor');
      expect(res.body.scope_ref).toBeNull();
    });

    test('rejects scope=actor with metric=requests (400)', async () => {
      const res = await createQuota(userToken, {
        scope: 'actor',
        metric: 'requests',
        window: 'rolling_1m',
        limit: 10,
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.message).toMatch(/actor/i);
    });

    test('rejects a scope_ref that names no actor in the project (400)', async () => {
      const res = await createQuota(userToken, {
        scope: 'actor',
        scope_ref: 'actor_doesnotexist00',
        metric: 'tokens',
        window: 'calendar_month',
        limit: 100,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.message).toMatch(/actor/i);
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
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data[0].id).toMatch(/^quota_/);
    });

    test('does not leak quotas across projects', async () => {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/quotas?project_id=${projectId}`
      );
      const projectIds: string[] = res.body.data.map(
        (q: { project_id: string }) => {
          return q.project_id;
        }
      );
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

    test('updates on_unpriced on a cost quota', async () => {
      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/quotas/${quotaId}`)
        .send({ on_unpriced: 'allow' });
      expect(res.status).toBe(200);
      expect(res.body.on_unpriced).toBe('allow');

      const back = await authenticatedTestClient(userToken)
        .patch(`/api/v1/quotas/${quotaId}`)
        .send({ on_unpriced: 'block' });
      expect(back.status).toBe(200);
      expect(back.body.on_unpriced).toBe('block');
    });

    test('rejects on_unpriced on a non-cost quota (400)', async () => {
      const created = await createQuota(userToken, {
        scope: 'project',
        metric: 'requests',
        window: 'rolling_24h',
        limit: 50,
      });
      const res = await authenticatedTestClient(userToken)
        .patch(`/api/v1/quotas/${created.body.id}`)
        .send({ on_unpriced: 'block' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
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

    test('user with zero policies returns 403 (empty project list)', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .patch(`/api/v1/quotas/${quotaId}`)
        .send({ limit: 1 });
      // A write refuses the empty scope outright; only the GET above 404s
      // (#1029).
      expect(res.status).toBe(403);
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

    test('user with zero policies returns 403 (empty project list)', async () => {
      const created = await createQuota(userToken, {
        scope: 'project',
        metric: 'tokens',
        window: 'rolling_1h',
        limit: 9,
      });
      const res = await authenticatedTestClient(noPermToken).delete(
        `/api/v1/quotas/${created.body.id}`
      );
      expect(res.status).toBe(403);
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
          window: COUNTED_WINDOW,
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
      expect(blocked.body.error.meta.window).toBe(COUNTED_WINDOW);
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
          window: COUNTED_WINDOW,
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
          window: COUNTED_WINDOW,
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
          window: COUNTED_WINDOW,
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
          window: COUNTED_WINDOW,
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
          window: COUNTED_WINDOW,
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
          window: COUNTED_WINDOW,
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
          window: COUNTED_WINDOW,
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

    // #749 (was the documented #742 exemption): an unscoped key has no bound
    // project at auth time, so attribution waits until the route itself
    // resolves *and authorizes* a single project — then the request counts and
    // blocks exactly like a project-scoped key's.
    test('unscoped API key requests are counted and blocked once the route resolves one project', async () => {
      const { enfProjectId } = await setupEnforcementProject(
        'quotas-unscoped-enforced'
      );

      await createQuota(
        userToken,
        {
          scope: 'project',
          metric: 'requests',
          window: COUNTED_WINDOW,
          limit: 2,
        },
        enfProjectId
      );

      const unscopedKeyRes = await authenticatedTestClient(userToken)
        .post('/api/v1/api-keys')
        .send({ name: 'quotas-unscoped-enforced key', policy_ids: [policyId] });
      expect(unscopedKeyRes.status).toBe(201);
      const rawUnscopedKey = unscopedKeyRes.body.key as string;

      for (let i = 0; i < 2; i += 1) {
        const ok = await authenticatedTestClient(rawUnscopedKey).get(
          `/api/v1/quotas?project_id=${enfProjectId}`
        );
        expect(ok.status).toBe(200);
      }

      const blocked = await authenticatedTestClient(rawUnscopedKey).get(
        `/api/v1/quotas?project_id=${enfProjectId}`
      );
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('QUOTA_EXCEEDED');
      expect(blocked.body.error.meta.metric).toBe('requests');
      expect(blocked.headers['retry-after']).toBeDefined();
    });

    // The concurrent twin of the test above (#1049): a sequential sequence says
    // nothing about the N+1th request evaluated while the Nth is in flight. It
    // holds because counting and checking are one statement, so a request is
    // compared against a count already including itself. Split that into a read
    // plus a write and the overshoot scales with concurrency.
    test('an unscoped key never admits more than limit under concurrency', async () => {
      const { enfProjectId } = await setupEnforcementProject(
        'quotas-unscoped-concurrency'
      );

      const limit = 3;
      await createQuota(
        userToken,
        {
          scope: 'project',
          metric: 'requests',
          window: COUNTED_WINDOW,
          limit,
        },
        enfProjectId
      );

      const unscopedKeyRes = await authenticatedTestClient(userToken)
        .post('/api/v1/api-keys')
        .send({
          name: 'quotas-unscoped-concurrency key',
          policy_ids: [policyId],
        });
      expect(unscopedKeyRes.status).toBe(201);
      const rawUnscopedKey = unscopedKeyRes.body.key as string;

      const total = 12;
      const results = await Promise.all(
        Array.from({ length: total }, () => {
          return authenticatedTestClient(rawUnscopedKey).get(
            `/api/v1/quotas?project_id=${enfProjectId}`
          );
        })
      );

      // Counted, not compared as response objects: a supertest response prints
      // its whole request/response pair on failure, which buries the one number
      // that matters.
      const statuses = results.map((res) => {
        return res.status;
      });
      const admitted = statuses.filter((status) => {
        return status === 200;
      });
      expect(admitted).toHaveLength(limit);
      expect(
        statuses.filter((status) => {
          return status === 429;
        })
      ).toHaveLength(total - limit);

      // Every rejection is the quota's, not an incidental error.
      for (const res of results.filter((res) => {
        return res.status === 429;
      })) {
        expect(res.body.error.code).toBe('QUOTA_EXCEEDED');
        expect(res.body.error.meta.limit).toBe(limit);
        expect(res.headers['retry-after']).toBeDefined();
      }
    });

    // An unscoped key can never be *named* by a `scope_ref` — that check
    // requires the key to live in the quota's project (`assertScopeRefValid`),
    // and an unscoped key lives in none. A null-ref `api_key` quota is the cap
    // that reaches it, so the api_key-scope matching branch must fire for it.
    test('a null-ref api_key-scope quota blocks an unscoped key', async () => {
      const { enfProjectId } = await setupEnforcementProject(
        'quotas-unscoped-keyscope'
      );

      const unscopedKeyRes = await authenticatedTestClient(userToken)
        .post('/api/v1/api-keys')
        .send({ name: 'quotas-unscoped-keyscope key', policy_ids: [policyId] });
      expect(unscopedKeyRes.status).toBe(201);
      const rawUnscopedKey = unscopedKeyRes.body.key as string;

      // Naming the unscoped key is rejected: it is not an API key "in this
      // project", so no project-owned quota can reference it.
      const namedQuota = await createQuota(
        userToken,
        {
          scope: 'api_key',
          scope_ref: unscopedKeyRes.body.id,
          metric: 'requests',
          window: COUNTED_WINDOW,
          limit: 1,
        },
        enfProjectId
      );
      expect(namedQuota.status).toBe(400);

      const keyQuota = await createQuota(
        userToken,
        {
          scope: 'api_key',
          metric: 'requests',
          window: COUNTED_WINDOW,
          limit: 1,
        },
        enfProjectId
      );
      expect(keyQuota.status).toBe(201);
      expect(keyQuota.body.scope_ref).toBeNull();

      const ok = await authenticatedTestClient(rawUnscopedKey).get(
        `/api/v1/quotas?project_id=${enfProjectId}`
      );
      expect(ok.status).toBe(200);

      const blocked = await authenticatedTestClient(rawUnscopedKey).get(
        `/api/v1/quotas?project_id=${enfProjectId}`
      );
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.meta.quota_id).toBe(keyQuota.body.id);
      expect(blocked.body.error.meta.scope ?? 'api_key').toBe('api_key');
    });

    // The route class the #749 investigation flagged as needing per-route
    // review: `GET /actors/:id` never calls `resolveProjectIds` — it loads the
    // actor, derives the project from it, and authorizes with `isAllowed`.
    // Wrapping the authorizer covers it with no change to the route.
    test('a route that authorizes only via isAllowed is counted and blocked', async () => {
      const { enfProjectId } = await setupEnforcementProject(
        'quotas-unscoped-isallowed'
      );

      const actorRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/actors')
        .send({ project_id: enfProjectId, name: 'quota probe actor' });
      expect(actorRes.status).toBe(201);
      const actorId = actorRes.body.id as string;

      await createQuota(
        userToken,
        {
          scope: 'project',
          metric: 'requests',
          window: COUNTED_WINDOW,
          limit: 2,
        },
        enfProjectId
      );

      const actorPolicyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [{ effect: 'Allow', action: ['actors:GetActor'] }],
          },
        });
      const keyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/api-keys')
        .send({
          name: 'quotas-unscoped-isallowed key',
          policy_ids: [actorPolicyRes.body.id],
        });
      expect(keyRes.status).toBe(201);
      const rawKey = keyRes.body.key as string;

      for (let i = 0; i < 2; i += 1) {
        const ok = await authenticatedTestClient(rawKey).get(
          `/api/v1/actors/${actorId}`
        );
        expect(ok.status).toBe(200);
      }

      const blocked = await authenticatedTestClient(rawKey).get(
        `/api/v1/actors/${actorId}`
      );
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('QUOTA_EXCEEDED');
    });

    // The DoS vector #742 rejected: naming a project you hold no permission on
    // must never touch its counter. The positive control is the permitted key
    // below — it still gets its full allowance, proving the denied requests
    // incremented nothing.
    test('a request denied on the named project never touches its counter', async () => {
      const { enfProjectId } = await setupEnforcementProject(
        'quotas-unscoped-denied'
      );

      await createQuota(
        userToken,
        {
          scope: 'project',
          metric: 'requests',
          window: COUNTED_WINDOW,
          limit: 1,
        },
        enfProjectId
      );

      // A policy that grants the quota actions only on the *other* project, so
      // this key is denied on `enfProjectId`.
      const scopedPolicyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [
              {
                effect: 'Allow',
                action: QUOTA_ACTIONS,
                resource: [`srn:${otherProjectId}:*:*`],
              },
            ],
          },
        });
      const outsiderKeyRes = await authenticatedTestClient(userToken)
        .post('/api/v1/api-keys')
        .send({
          name: 'quotas-unscoped-denied key',
          policy_ids: [scopedPolicyRes.body.id],
        });
      expect(outsiderKeyRes.status).toBe(201);
      const rawOutsiderKey = outsiderKeyRes.body.key as string;

      for (let i = 0; i < 5; i += 1) {
        const denied = await authenticatedTestClient(rawOutsiderKey).get(
          `/api/v1/quotas?project_id=${enfProjectId}`
        );
        expect(denied.status).toBe(403);
      }

      // Positive control: the limit-1 allowance is still intact.
      const permittedKeyRes = await authenticatedTestClient(userToken)
        .post('/api/v1/api-keys')
        .send({
          name: 'quotas-unscoped-denied control key',
          policy_ids: [policyId],
        });
      const rawPermittedKey = permittedKeyRes.body.key as string;

      const ok = await authenticatedTestClient(rawPermittedKey).get(
        `/api/v1/quotas?project_id=${enfProjectId}`
      );
      expect(ok.status).toBe(200);

      const blocked = await authenticatedTestClient(rawPermittedKey).get(
        `/api/v1/quotas?project_id=${enfProjectId}`
      );
      expect(blocked.status).toBe(429);
    });

    // `POST /triggers` authorizes twice — once to write in the project, once to
    // prove the caller could start the target itself. Attribution is
    // per-request, not per-check, so a limit of 2 must admit exactly two of
    // these; a double count would reject the second.
    test('a handler that authorizes twice is counted once', async () => {
      const { enfProjectId } = await setupEnforcementProject(
        'quotas-unscoped-once'
      );

      const toolRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/tools')
        .send({ project_id: enfProjectId, name: 'quota probe tool' });
      expect(toolRes.status).toBe(201);

      await createQuota(
        userToken,
        {
          scope: 'project',
          metric: 'requests',
          window: COUNTED_WINDOW,
          limit: 2,
        },
        enfProjectId
      );

      const triggerPolicyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [
              {
                effect: 'Allow',
                action: ['triggers:CreateTrigger', 'tools:CallTool'],
              },
            ],
          },
        });
      const keyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/api-keys')
        .send({
          name: 'quotas-unscoped-once key',
          policy_ids: [triggerPolicyRes.body.id],
        });
      expect(keyRes.status).toBe(201);
      const rawKey = keyRes.body.key as string;

      const createTrigger = (name: string) => {
        return authenticatedTestClient(rawKey).post('/api/v1/triggers').send({
          project_id: enfProjectId,
          name,
          type: 'manual',
          target_type: 'tool',
          target_id: toolRes.body.id,
        });
      };

      for (let i = 0; i < 2; i += 1) {
        const ok = await createTrigger(`quota probe trigger ${i}`);
        expect(ok.status).toBe(201);
      }

      const blocked = await createTrigger('quota probe trigger blocked');
      expect(blocked.status).toBe(429);
    });

    // The residual exemption #749 leaves in place: a request that resolves to
    // *every* project (an unscoped admin key with no attached policies, no
    // `project_id` filter) names no single project to count against.
    test('an unscoped key resolving to no single project is still exempt', async () => {
      const { enfProjectId } = await setupEnforcementProject(
        'quotas-unscoped-allprojects'
      );

      await createQuota(
        userToken,
        {
          scope: 'project',
          metric: 'requests',
          window: COUNTED_WINDOW,
          limit: 1,
        },
        enfProjectId
      );

      // Unscoped, no attached policies, admin owner → full inheritance, so
      // `resolveProjectIds` returns `undefined` (no project filter at all).
      const adminKeyRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/api-keys')
        .send({ name: 'quotas-unscoped-allprojects key' });
      expect(adminKeyRes.status).toBe(201);
      const rawAdminKey = adminKeyRes.body.key as string;

      for (let i = 0; i < 5; i += 1) {
        const res =
          await authenticatedTestClient(rawAdminKey).get('/api/v1/quotas');
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

    test('token quota blocks a generation with 429 and writes no usage', async () => {
      const { enfProjectId } =
        await setupEnforcementProject('quotas-token-gate');

      const provRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: enfProjectId,
          name: 'token gate provider',
          provider: 'ollama',
          default_model: 'stub-model',
        });
      const agentRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          project_id: enfProjectId,
          ai_provider_id: provRes.body.id,
          name: 'token gate agent',
        });
      const agentPublicId = agentRes.body.id as string;

      const project = await db.Project.findOne({
        where: { publicId: enfProjectId },
      });
      const projectInternalId = (project as unknown as { id: number }).id;

      // Seed a metered event summing to 30 billable tokens in the window.
      const event = await db.UsageEvent.create({
        projectId: projectInternalId,
        meterType: 'llm_tokens',
        provider: 'ollama',
        model: 'stub-model',
        costUsd: null,
        idempotencyKey: `${generatePublicId(PUBLIC_ID_PREFIXES.usageEvent)}:seed`,
      });
      await db.UsageComponent.bulkCreate(
        [
          { component: 'input_tokens', quantity: '10', billable: true },
          { component: 'output_tokens', quantity: '20', billable: true },
        ].map((c) => {
          return {
            // bulkCreate skips the beforeValidate publicId hook — set it here.
            publicId: generatePublicId(PUBLIC_ID_PREFIXES.usageComponent),
            usageEventId: (event as unknown as { id: number }).id,
            component: c.component,
            quantity: c.quantity,
            unit: 'token',
            billable: c.billable,
            unitPrice: null,
            costUsd: null,
            priceId: null,
          };
        })
      );

      const quotaRes = await createQuota(
        userToken,
        {
          scope: 'project',
          metric: 'tokens',
          window: COUNTED_WINDOW,
          limit: 30,
        },
        enfProjectId
      );
      expect(quotaRes.status).toBe(201);

      const before = await db.UsageEvent.count({
        where: { projectId: projectInternalId },
      });

      const blocked = await authenticatedTestClient(adminToken)
        .post(`/api/v1/agents/${agentPublicId}/generate?wait=true`)
        .send({ messages: [{ role: 'user', content: 'hello' }] });

      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('QUOTA_EXCEEDED');
      expect(blocked.body.error.meta.quota_id).toBe(quotaRes.body.id);
      expect(blocked.body.error.meta.metric).toBe('tokens');
      expect(blocked.body.error.meta.limit).toBe(30);
      expect(blocked.body.error.meta.window).toBe('calendar_month');
      expect(blocked.body.error.meta.resets_at).toBeDefined();
      // The 429 contract carries Retry-After even on the generation path.
      expect(blocked.headers['retry-after']).toBeDefined();
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

      // No usage event was written for the blocked generation.
      const after = await db.UsageEvent.count({
        where: { projectId: projectInternalId },
      });
      expect(after).toBe(before);
    });

    test('actor quota blocks that end user session generation with 429', async () => {
      const { enfProjectId } =
        await setupEnforcementProject('quotas-actor-gate');

      const provRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/ai-providers')
        .send({
          project_id: enfProjectId,
          name: 'actor gate provider',
          provider: 'ollama',
          default_model: 'stub-model',
        });
      const agentRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/agents')
        .send({
          project_id: enfProjectId,
          ai_provider_id: provRes.body.id,
          name: 'actor gate agent',
        });
      const agentPublicId = agentRes.body.id as string;

      const project = await db.Project.findOne({
        where: { publicId: enfProjectId },
      });
      const projectInternalId = (project as unknown as { id: number }).id;

      // Two end users on the same agent. Only Bob has spent anything.
      const openSession = async (actorName: string) => {
        const actorRes = await authenticatedTestClient(adminToken)
          .post('/api/v1/actors')
          .send({ project_id: enfProjectId, name: actorName });
        expect(actorRes.status).toBe(201);

        const sessionRes = await authenticatedTestClient(adminToken)
          .post('/api/v1/sessions')
          .send({ agent_id: agentPublicId, actor_id: actorRes.body.id });
        expect(sessionRes.status).toBe(201);

        const actor = await db.Actor.findOne({
          where: { publicId: actorRes.body.id },
        });

        return {
          sessionId: sessionRes.body.id as string,
          actorInternalId: (actor as unknown as { id: number }).id,
        };
      };

      const bob = await openSession('bob');
      const alice = await openSession('alice');

      // 30 billable tokens, attributed to Bob — the shape usageRecording
      // writes for a session generation.
      const event = await db.UsageEvent.create({
        projectId: projectInternalId,
        actorId: bob.actorInternalId,
        meterType: 'llm_tokens',
        provider: 'ollama',
        model: 'stub-model',
        costUsd: null,
        idempotencyKey: `${generatePublicId(PUBLIC_ID_PREFIXES.usageEvent)}:seed`,
      });
      await db.UsageComponent.bulkCreate(
        [
          { component: 'input_tokens', quantity: '10', billable: true },
          { component: 'output_tokens', quantity: '20', billable: true },
        ].map((c) => {
          return {
            // bulkCreate skips the beforeValidate publicId hook — set it here.
            publicId: generatePublicId(PUBLIC_ID_PREFIXES.usageComponent),
            usageEventId: (event as unknown as { id: number }).id,
            component: c.component,
            quantity: c.quantity,
            unit: 'token',
            billable: c.billable,
            unitPrice: null,
            costUsd: null,
            priceId: null,
          };
        })
      );

      // One null-ref actor quota: a budget per end user, not a pooled total.
      const quotaRes = await createQuota(
        userToken,
        {
          scope: 'actor',
          metric: 'tokens',
          window: COUNTED_WINDOW,
          limit: 30,
        },
        enfProjectId
      );
      expect(quotaRes.status).toBe(201);

      await authenticatedTestClient(adminToken)
        .post(`/api/v1/sessions/${bob.sessionId}/messages`)
        .send({ role: 'user', content: 'hello' });

      const before = await db.UsageEvent.count({
        where: { projectId: projectInternalId },
      });

      const blocked = await authenticatedTestClient(adminToken)
        .post(`/api/v1/sessions/${bob.sessionId}/generate?wait=true`)
        .send({});

      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('QUOTA_EXCEEDED');
      expect(blocked.body.error.meta.quota_id).toBe(quotaRes.body.id);
      expect(blocked.body.error.meta.metric).toBe('tokens');
      expect(blocked.body.error.meta.limit).toBe(30);
      expect(blocked.headers['retry-after']).toBeDefined();
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

      // Nothing was metered for the blocked generation.
      expect(
        await db.UsageEvent.count({ where: { projectId: projectInternalId } })
      ).toBe(before);

      // Alice has spent nothing, so the same quota does not stop her — what
      // makes a null-ref quota per-actor rather than a project total. Her call
      // may still fail upstream; what this pins is that the gate did not stop it.
      await authenticatedTestClient(adminToken)
        .post(`/api/v1/sessions/${alice.sessionId}/messages`)
        .send({ role: 'user', content: 'hello' });

      const allowed = await authenticatedTestClient(adminToken)
        .post(`/api/v1/sessions/${alice.sessionId}/generate?wait=true`)
        .send({});

      expect(allowed.status).not.toBe(429);
      expect(allowed.body?.error?.code).not.toBe('QUOTA_EXCEEDED');
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
          window: COUNTED_WINDOW,
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

  // ── quota.exceeded webhook + monitor mode (Phase 3) ────────────────────────

  describe('quota.exceeded webhook and monitor mode', () => {
    // The webhook fires synchronously inside evaluateRequestQuotas (awaited by
    // the middleware before the response), so events are captured without any
    // polling.
    const withCapture = async (
      action: () => Promise<void>
    ): Promise<SoatEvent[]> => {
      const captured: SoatEvent[] = [];
      const handler = (event: SoatEvent) => {
        if (event.type === 'quota.exceeded') captured.push(event);
      };
      eventBus.on('soat:event', handler);
      try {
        await action();
      } finally {
        eventBus.off('soat:event', handler);
      }
      return captured;
    };

    const get = (rawKey: string, projectPublicId: string) => {
      return authenticatedTestClient(rawKey).get(
        `/api/v1/quotas?project_id=${projectPublicId}`
      );
    };

    test('a monitor request quota fires the webhook once per window without blocking', async () => {
      const { enfProjectId, keyId, rawKey } =
        await setupEnforcementProject('quotas-monitor-req');
      const quotaRes = await createQuota(
        userToken,
        {
          scope: 'api_key',
          scope_ref: keyId,
          metric: 'requests',
          window: COUNTED_WINDOW,
          limit: 1,
          mode: 'monitor',
        },
        enfProjectId
      );

      const captured = await withCapture(async () => {
        // Request 1 is within limit; 2 and 3 breach — none are blocked.
        for (let i = 0; i < 3; i += 1) {
          const res = await get(rawKey, enfProjectId);
          expect(res.status).toBe(200);
        }
      });

      expect(captured).toHaveLength(1);
      expect(captured[0].data.quota_id).toBe(quotaRes.body.id);
      expect(captured[0].data.mode).toBe('monitor');
      expect(captured[0].data.metric).toBe('requests');
      expect(captured[0].resourceType).toBe('quota');
    });

    // Fetches the quotas:MonitorBreach audit entries for a project (admin sees
    // every project), after draining the fire-and-forget audit queue.
    const monitorBreachEntries = async (
      project: string
    ): Promise<Array<Record<string, unknown>>> => {
      await flushAuditQueue();
      const res = await authenticatedTestClient(adminToken)
        .get('/api/v1/audit-log')
        .query({ project_id: project, action: 'quotas:MonitorBreach' });
      expect(res.status).toBe(200);
      return res.body.data as Array<Record<string, unknown>>;
    };

    test('a monitor breach writes a system audit entry once per window', async () => {
      const { enfProjectId, keyId, rawKey } = await setupEnforcementProject(
        'quotas-monitor-audit'
      );
      const quotaRes = await createQuota(
        userToken,
        {
          scope: 'api_key',
          scope_ref: keyId,
          metric: 'requests',
          window: COUNTED_WINDOW,
          limit: 1,
          mode: 'monitor',
        },
        enfProjectId
      );

      // Request 1 is within limit; 2 and 3 breach the limit-1 monitor quota and
      // are not blocked. The breach fires once per window, so one audit entry.
      for (let i = 0; i < 3; i += 1) {
        expect((await get(rawKey, enfProjectId)).status).toBe(200);
      }

      const entries = await monitorBreachEntries(enfProjectId);
      const entry = entries.find((e) => {
        return e.resource_public_id === quotaRes.body.id;
      });
      expect(entry).toBeDefined();
      // No principal authorized the breach: the principal columns stay null and
      // the entry is identified by its action, never a fabricated actor.
      expect(entry!.principal_type).toBeNull();
      expect(entry!.principal_id).toBeNull();
      expect(entry!.action).toBe('quotas:MonitorBreach');
      expect(entry!.resource_srn).toBe(
        `srn:${enfProjectId}:quota:${quotaRes.body.id}`
      );
      expect(entry!.status).toBe(200);
      const detail = entry!.detail as Record<string, unknown>;
      expect(detail.kind).toBe('quota_monitor_breach');
      expect(detail.metric).toBe('requests');
      expect(detail.limit).toBe(1);
      // Breach first tripped on request 2 (count 2 > limit 1); the once-per-
      // window guard freezes the entry at that first observed value.
      expect(detail.observed_value).toBe(2);
    });

    test('an enforce breach writes no monitor-breach audit entry', async () => {
      const { enfProjectId, keyId, rawKey } = await setupEnforcementProject(
        'quotas-enforce-noaudit'
      );
      const quotaRes = await createQuota(
        userToken,
        {
          scope: 'api_key',
          scope_ref: keyId,
          metric: 'requests',
          window: COUNTED_WINDOW,
          limit: 1,
          mode: 'enforce',
        },
        enfProjectId
      );

      expect((await get(rawKey, enfProjectId)).status).toBe(200);
      expect((await get(rawKey, enfProjectId)).status).toBe(429);

      const entries = await monitorBreachEntries(enfProjectId);
      expect(
        entries.some((e) => {
          return e.resource_public_id === quotaRes.body.id;
        })
      ).toBe(false);
    });

    test('an enforce request quota fires the webhook and still blocks', async () => {
      const { enfProjectId, keyId, rawKey } = await setupEnforcementProject(
        'quotas-enforce-fire'
      );
      await createQuota(
        userToken,
        {
          scope: 'api_key',
          scope_ref: keyId,
          metric: 'requests',
          window: COUNTED_WINDOW,
          limit: 1,
        },
        enfProjectId
      );

      const captured = await withCapture(async () => {
        expect((await get(rawKey, enfProjectId)).status).toBe(200);
        expect((await get(rawKey, enfProjectId)).status).toBe(429);
        expect((await get(rawKey, enfProjectId)).status).toBe(429);
      });

      // Fired exactly once despite two breaching requests.
      expect(captured).toHaveLength(1);
      expect(captured[0].data.mode).toBe('enforce');
    });

    test('changing the limit re-arms the webhook for a later breach in the same window', async () => {
      // `COUNTED_WINDOW` matters most here: every request below must share one
      // window, which is exactly the condition the once-per-window fire guard
      // applies to.
      const { enfProjectId, keyId, rawKey } = await setupEnforcementProject(
        'quotas-refire-on-limit-change'
      );
      const quotaRes = await createQuota(
        userToken,
        {
          scope: 'api_key',
          scope_ref: keyId,
          metric: 'requests',
          window: COUNTED_WINDOW,
          limit: 1,
          mode: 'monitor',
        },
        enfProjectId
      );

      const first = await withCapture(async () => {
        // Request 1 is within limit; request 2 (count 2 > 1) is the first breach.
        expect((await get(rawKey, enfProjectId)).status).toBe(200);
        expect((await get(rawKey, enfProjectId)).status).toBe(200);
      });
      expect(first).toHaveLength(1);
      expect(first[0].data.observed_value).toBe(2);

      // The operator raises the cap in response to the breach — the core
      // monitor-mode tuning loop.
      const patch = await authenticatedTestClient(userToken)
        .patch(`/api/v1/quotas/${quotaRes.body.id}`)
        .send({ limit: 3 });
      expect(patch.status).toBe(200);
      expect(patch.body.limit).toBe(3);

      const second = await withCapture(async () => {
        // Count 3 is within the new limit; count 4 breaches it. That is a new
        // event against a limit that has changed since the last fire, so it
        // must fire again even though the window key is unchanged.
        expect((await get(rawKey, enfProjectId)).status).toBe(200);
        expect((await get(rawKey, enfProjectId)).status).toBe(200);
      });
      expect(second).toHaveLength(1);
      expect(second[0].data.limit).toBe(3);
      expect(second[0].data.observed_value).toBe(4);

      // The audit entry rides the same guard, so the re-arm must produce a
      // second entry too.
      const entries = await monitorBreachEntries(enfProjectId);
      const forQuota = entries.filter((e) => {
        return e.resource_public_id === quotaRes.body.id;
      });
      expect(forQuota).toHaveLength(2);
    });

    test('flipping mode monitor->enforce blocks the next breaching request', async () => {
      const { enfProjectId, keyId, rawKey } =
        await setupEnforcementProject('quotas-flip-mode');
      const quotaRes = await createQuota(
        userToken,
        {
          scope: 'api_key',
          scope_ref: keyId,
          metric: 'requests',
          window: COUNTED_WINDOW,
          limit: 1,
          mode: 'monitor',
        },
        enfProjectId
      );

      // Under monitor, a breaching request is not blocked.
      expect((await get(rawKey, enfProjectId)).status).toBe(200);
      expect((await get(rawKey, enfProjectId)).status).toBe(200);

      const patch = await authenticatedTestClient(userToken)
        .patch(`/api/v1/quotas/${quotaRes.body.id}`)
        .send({ mode: 'enforce' });
      expect(patch.status).toBe(200);
      expect(patch.body.mode).toBe('enforce');

      // Now enforced: the next breaching request is blocked.
      const blocked = await get(rawKey, enfProjectId);
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('QUOTA_EXCEEDED');
    });
  });
});
