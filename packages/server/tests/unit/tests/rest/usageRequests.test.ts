import {
  flushRequestCounters,
  resetRequestCounters,
} from 'src/lib/usageRequests';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

// API-request metering has no HTTP entry point of its own — the middleware
// counts every project/api-key request in memory and a scheduler flushes the
// counts to `api_request` usage events. We drive real requests with a
// project-scoped key, flush directly (the sanctioned no-entry-point path), and
// read the aggregated event back through GET /api/v1/usage/meters.

describe('Usage — API-request metering', () => {
  let userToken: string;
  let projectId: string;
  let policyId: string;
  let rawKey: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'usagereq',
      policyActions: ['usage:ListUsageMeters'],
    });
    userToken = setup.userToken;
    projectId = setup.projectId;
    policyId = setup.policyId;

    // A project-scoped key carrying the same policy, so its requests are both
    // counted (api-key + project scoped) and able to read the meters back.
    const keyRes = await authenticatedTestClient(userToken)
      .post('/api/v1/api-keys')
      .send({
        name: 'metered key',
        project_id: projectId,
        policy_ids: [policyId],
      });
    expect(keyRes.status).toBe(201);
    rawKey = keyRes.body.key;
  });

  const apiRequestMeters = async (): Promise<
    Array<{
      meter_type: string;
      components: Array<{ component: string; quantity: string; unit: string }>;
    }>
  > => {
    const res = await authenticatedTestClient(rawKey).get(
      '/api/v1/usage/meters?meter_type=api_request'
    );
    expect(res.status).toBe(200);
    return res.body.data;
  };

  test('aggregates counted requests into one api_request event per window', async () => {
    resetRequestCounters();

    // Three project-key requests are counted on arrival (before quota).
    for (let i = 0; i < 3; i += 1) {
      const res = await authenticatedTestClient(rawKey).get(
        '/api/v1/usage/meters?meter_type=api_request'
      );
      expect(res.status).toBe(200);
    }

    const written = await flushRequestCounters({ now: new Date() });
    expect(written).toBeGreaterThanOrEqual(1);

    const events = await apiRequestMeters();
    expect(events).toHaveLength(1);
    expect(events[0].meter_type).toBe('api_request');
    const comp = events[0].components.find((c) => {
      return c.component === 'request';
    });
    expect(comp).toBeDefined();
    expect(comp!.unit).toBe('request');
    // Exactly the three requests that arrived before the flush; the read-back
    // request below lands in the next (unflushed) window.
    expect(Number(comp!.quantity)).toBe(3);
  });

  test('a re-flush of the same window writes nothing (idempotent)', async () => {
    resetRequestCounters();
    await authenticatedTestClient(rawKey).get(
      '/api/v1/usage/meters?meter_type=api_request'
    );
    const now = new Date();
    const first = await flushRequestCounters({ now });
    expect(first).toBeGreaterThanOrEqual(1);
    // Nothing accumulated since; a second flush has no counters to write.
    const second = await flushRequestCounters({ now });
    expect(second).toBe(0);
  });

  test('JWT-user requests are never counted', async () => {
    resetRequestCounters();
    // A JWT (non-api-key) request must not increment any counter.
    const res = await authenticatedTestClient(userToken).get(
      '/api/v1/usage/meters?meter_type=api_request'
    );
    expect(res.status).toBe(200);
    const written = await flushRequestCounters({ now: new Date() });
    expect(written).toBe(0);
  });

  test('unauthenticated meters request returns 401', async () => {
    const res = await testClient.get(
      '/api/v1/usage/meters?meter_type=api_request'
    );
    expect(res.status).toBe(401);
  });
});
