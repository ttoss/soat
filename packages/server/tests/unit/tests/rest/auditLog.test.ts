import { db } from 'src/db';
import * as auditLog from 'src/lib/auditLog';
import {
  flushAuditQueue,
  getDroppedAuditCount,
  resetAuditQueue,
} from 'src/lib/auditQueue';
import { runRetentionSweep } from 'src/lib/auditScheduler';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

const P = 'audit';

let adminToken: string;
let userToken: string;
let noPermToken: string;
let projectId: string;

beforeAll(async () => {
  const setup = await setupProjectWithUsers({
    prefix: P,
    policyActions: [
      'secrets:CreateSecret',
      'secrets:GetSecret',
      'secrets:ListSecrets',
      'secrets:UpdateSecret',
      'secrets:DeleteSecret',
      'tools:CreateTool',
      'tools:CallTool',
      'tools:GetTool',
      'triggers:CreateTrigger',
      'triggers:ListTriggers',
      'audit:ListAuditEntries',
      'audit:GetAuditEntry',
    ],
    createNoPermUser: true,
  });
  adminToken = setup.adminToken;
  userToken = setup.userToken;
  noPermToken = setup.noPermToken!;
  projectId = setup.projectId;
});

/** Lists audit entries as admin (sees all projects) after draining the queue. */
const listEntries = async (
  query: Record<string, string> = {}
): Promise<Array<Record<string, unknown>>> => {
  await flushAuditQueue();
  const res = await authenticatedTestClient(adminToken)
    .get('/api/v1/audit-log')
    .query(query);
  expect(res.status).toBe(200);
  return res.body.data as Array<Record<string, unknown>>;
};

describe('Audit Log — request id middleware', () => {
  test('every /api/v1 response carries an X-Request-Id header', async () => {
    const res = await authenticatedTestClient(userToken).get('/api/v1/secrets');
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBeDefined();
    expect(res.headers['x-request-id'].length).toBeGreaterThan(0);
  });

  test('a caller-supplied X-Request-Id is echoed back', async () => {
    const res = await authenticatedTestClient(userToken)
      .get('/api/v1/secrets')
      .set('X-Request-Id', 'req-correlation-123');
    expect(res.headers['x-request-id']).toBe('req-correlation-123');
  });
});

describe('Audit Log — write hook', () => {
  test('create then delete a secret yields two entries with correct actions, statuses, SRNs, and resource_public_id', async () => {
    const createRes = await authenticatedTestClient(userToken)
      .post('/api/v1/secrets')
      .send({ project_id: projectId, name: 'AUDIT_CREATE', value: 'v' });
    expect(createRes.status).toBe(201);
    const secretId = createRes.body.id as string;
    const requestId = createRes.headers['x-request-id'];

    const deleteRes = await authenticatedTestClient(userToken).delete(
      `/api/v1/secrets/${secretId}`
    );
    expect(deleteRes.status).toBe(204);

    const entries = await listEntries({ resource_public_id: secretId });

    const create = entries.find((e) => {
      return e.action === 'secrets:CreateSecret';
    })!;
    const del = entries.find((e) => {
      return e.action === 'secrets:DeleteSecret';
    })!;

    expect(create).toBeDefined();
    expect(create.status).toBe(201);
    // Create authorizes before the resource exists → type-level SRN.
    expect(create.resource_srn).toBe(`soat:${projectId}:secret:*`);
    // resource_public_id captured from the response body id.
    expect(create.resource_public_id).toBe(secretId);
    expect(create.request_id).toBe(requestId);
    expect(create.actor_type).toBe('user');
    expect(create.project_id).toBe(projectId);

    expect(del).toBeDefined();
    expect(del.status).toBe(204);
    // Delete authorizes against the precise resource SRN.
    expect(del.resource_srn).toBe(`soat:${projectId}:secret:${secretId}`);
    expect(del.resource_public_id).toBe(secretId);
  });

  test('a denied delete (missing permission) yields one entry with status 403 and the same action', async () => {
    // Admin creates a secret the no-perm user will try (and fail) to delete.
    const createRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/secrets')
      .send({ project_id: projectId, name: 'AUDIT_DENIED', value: 'v' });
    const secretId = createRes.body.id as string;

    const deleteRes = await authenticatedTestClient(noPermToken).delete(
      `/api/v1/secrets/${secretId}`
    );
    expect(deleteRes.status).toBe(403);

    const entries = await listEntries({ resource_public_id: secretId });
    const denied = entries.find((e) => {
      return e.action === 'secrets:DeleteSecret' && e.status === 403;
    });
    expect(denied).toBeDefined();
    expect(denied!.resource_srn).toBe(`soat:${projectId}:secret:${secretId}`);
  });

  test('GET requests write no audit entries', async () => {
    const before = (await listEntries()).length;
    await authenticatedTestClient(userToken).get('/api/v1/secrets');
    await authenticatedTestClient(userToken).get(
      `/api/v1/audit-log?project_id=${projectId}`
    );
    const after = (await listEntries()).length;
    expect(after).toBe(before);
  });

  test('a route that makes multiple isAllowed checks produces one entry with additional_checks', async () => {
    const toolRes = await authenticatedTestClient(userToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'audit-tool',
        type: 'http',
        execute: { url: 'https://example.com/hook', method: 'POST' },
      });
    expect(toolRes.status).toBe(201);
    const toolId = toolRes.body.id as string;

    const triggerRes = await authenticatedTestClient(userToken)
      .post('/api/v1/triggers')
      .send({
        project_id: projectId,
        name: 'audit-trigger',
        type: 'manual',
        target_type: 'tool',
        target_id: toolId,
      });
    expect(triggerRes.status).toBe(201);
    const triggerId = triggerRes.body.id as string;

    const entries = await listEntries({ resource_public_id: triggerId });
    const created = entries.filter((e) => {
      return e.action === 'triggers:CreateTrigger';
    });
    // Exactly one entry despite two isAllowed checks in the handler.
    expect(created).toHaveLength(1);
    const entry = created[0];
    // Primary is the route's own (first) check on success.
    expect(entry.action).toBe('triggers:CreateTrigger');
    expect(entry.status).toBe(201);
    const detail = entry.detail as {
      additional_checks?: Array<Record<string, unknown>>;
    } | null;
    expect(detail?.additional_checks).toBeDefined();
    expect(detail!.additional_checks!).toHaveLength(1);
    expect(detail!.additional_checks![0].action).toBe('tools:CallTool');
    expect(detail!.additional_checks![0].allowed).toBe(true);
  });

  test('a failing audit writer never changes the request response', async () => {
    // Sanctioned force-failure stub (see tests.md): the queue's `.catch()`
    // resilience branch can only be driven by making the write reject, and no
    // real DB write fails deterministically. The create still runs against the
    // real DB; only the async audit write is forced to reject once.
    const spy = jest
      .spyOn(auditLog, 'writeAuditEntry')
      .mockRejectedValueOnce(new Error('DB is down'));

    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/secrets')
      .send({ project_id: projectId, name: 'AUDIT_RESILIENT', value: 'v' });

    // The write rejection is swallowed by the queue; the create still succeeds.
    expect(res.status).toBe(201);
    await flushAuditQueue();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('Audit Log — read API filters', () => {
  test('?action= returns only entries with that action', async () => {
    const entries = await listEntries({ action: 'secrets:CreateSecret' });
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.action).toBe('secrets:CreateSecret');
    }
  });

  test('?resource_public_id= returns only that resource’s entries', async () => {
    const createRes = await authenticatedTestClient(userToken)
      .post('/api/v1/secrets')
      .send({ project_id: projectId, name: 'AUDIT_FILTER', value: 'v' });
    const secretId = createRes.body.id as string;

    const entries = await listEntries({ resource_public_id: secretId });
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.resource_public_id).toBe(secretId);
    }
  });

  test('?resource_srn= matches by prefix', async () => {
    const entries = await listEntries({
      resource_srn: `soat:${projectId}:secret:`,
    });
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(
        String(e.resource_srn).startsWith(`soat:${projectId}:secret:`)
      ).toBe(true);
    }
  });

  test('?from=/?to= bound results by createdAt, and an invalid date is ignored', async () => {
    // A wide window (valid ISO dates) returns entries.
    const within = await listEntries({
      from: '2000-01-01T00:00:00.000Z',
      to: '2999-01-01T00:00:00.000Z',
    });
    expect(within.length).toBeGreaterThan(0);

    // A future-only lower bound excludes every existing entry.
    const future = await listEntries({ from: '2999-01-01T00:00:00.000Z' });
    expect(future).toHaveLength(0);

    // A malformed date parses to undefined (ignored, not applied as a filter),
    // so results are unaffected rather than erroring.
    const ignored = await listEntries({ from: 'not-a-real-date' });
    expect(ignored.length).toBeGreaterThan(0);
  });
});

describe('Audit Log — read API authorization', () => {
  test('unauthenticated list returns 401', async () => {
    const res = await testClient.get('/api/v1/audit-log');
    expect(res.status).toBe(401);
  });

  test('a user without audit permission gets 403', async () => {
    const res = await authenticatedTestClient(noPermToken).get(
      `/api/v1/audit-log?project_id=${projectId}`
    );
    expect(res.status).toBe(403);
  });

  test('a user with audit:ListAuditEntries can list', async () => {
    const res = await authenticatedTestClient(userToken)
      .get('/api/v1/audit-log')
      .query({ project_id: projectId });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  test('get one entry: happy path, 404, and 401', async () => {
    const all = await listEntries();
    const entryId = all[0].id as string;

    const ok = await authenticatedTestClient(adminToken).get(
      `/api/v1/audit-log/${entryId}`
    );
    expect(ok.status).toBe(200);
    expect(ok.body.id).toBe(entryId);
    expect(ok.body.action).toBeDefined();

    const missing = await authenticatedTestClient(adminToken).get(
      '/api/v1/audit-log/audit_doesnotexist0000'
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('RESOURCE_NOT_FOUND');

    const unauth = await testClient.get(`/api/v1/audit-log/${entryId}`);
    expect(unauth.status).toBe(401);
  });

  test('a project-scoped credential lacking audit permission gets 403 fetching one entry', async () => {
    const all = await listEntries();
    const entryId = all[0].id as string;

    // A project-scoped API key whose boundary policy grants only secrets access
    // (no audit:*): its resolveProjectIds probes the bound project, the check
    // fails, and the get-one handler returns 403 (the null branch a plain JWT —
    // which returns [] and 404s — never reaches).
    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [{ effect: 'Allow', action: ['secrets:GetSecret'] }],
        },
      });
    const keyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/api-keys')
      .send({
        name: 'audit-no-perm-key',
        project_id: projectId,
        policy_ids: [policyRes.body.id],
      });
    const rawKey = keyRes.body.key as string;

    const res = await authenticatedTestClient(rawKey).get(
      `/api/v1/audit-log/${entryId}`
    );
    expect(res.status).toBe(403);
  });
});

describe('Audit Log — append-only', () => {
  test('the model rejects updates', async () => {
    const all = await listEntries();
    const entry = await db.AuditEntry.findOne({
      where: { publicId: all[0].id as string },
    });
    await expect(
      db.AuditEntry.update(
        { status: 999 },
        { where: { id: entry!.id as number } }
      )
    ).rejects.toThrow(/append-only/i);
  });
});

describe('Audit Log — retention sweep', () => {
  afterEach(() => {
    delete process.env.AUDIT_RETENTION_DAYS;
  });

  test('a backdated row is pruned and a fresh row survives', async () => {
    resetAuditQueue();
    // Seed a fresh entry through a real request.
    const createRes = await authenticatedTestClient(userToken)
      .post('/api/v1/secrets')
      .send({ project_id: projectId, name: 'AUDIT_RETAIN', value: 'v' });
    const freshSecretId = createRes.body.id as string;
    await flushAuditQueue();

    const fresh = await db.AuditEntry.findOne({
      where: { resourcePublicId: freshSecretId },
    });
    expect(fresh).not.toBeNull();

    // Backdate it well past a 1-day window (raw SQL bypasses the append-only hook).
    const old = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    await db.sequelize.query(
      'UPDATE audit_entries SET created_at = :old WHERE public_id = :id',
      { replacements: { old, id: fresh!.publicId as string } }
    );

    // Seed a second, genuinely fresh entry that must survive.
    const survivorRes = await authenticatedTestClient(userToken)
      .post('/api/v1/secrets')
      .send({ project_id: projectId, name: 'AUDIT_SURVIVOR', value: 'v' });
    const survivorId = survivorRes.body.id as string;
    await flushAuditQueue();

    process.env.AUDIT_RETENTION_DAYS = '1';
    const removed = await auditLog.sweepExpiredAuditEntries();
    expect(removed).toBeGreaterThanOrEqual(1);

    const backdated = await db.AuditEntry.findOne({
      where: { publicId: fresh!.publicId as string },
    });
    expect(backdated).toBeNull();

    const survivor = await db.AuditEntry.findOne({
      where: { resourcePublicId: survivorId },
    });
    expect(survivor).not.toBeNull();
  });

  test('runRetentionSweep swallows into a count (scheduler tick body)', async () => {
    // Default 365-day window prunes nothing fresh; the wrapper returns a count
    // rather than throwing, matching the scheduler's fire-and-forget contract.
    const removed = await runRetentionSweep();
    expect(typeof removed).toBe('number');
    expect(removed).toBeGreaterThanOrEqual(0);
  });
});

describe('Audit Log — pagination and queue metrics', () => {
  test('limit/offset are applied to the list response', async () => {
    const res = await authenticatedTestClient(adminToken)
      .get('/api/v1/audit-log')
      .query({ limit: '1', offset: '0' });
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(1);
    expect(res.body.offset).toBe(0);
    expect(res.body.data.length).toBeLessThanOrEqual(1);
    expect(typeof res.body.total).toBe('number');
  });

  test('the dropped-entry counter is exposed as a number', async () => {
    expect(typeof getDroppedAuditCount()).toBe('number');
    expect(getDroppedAuditCount()).toBeGreaterThanOrEqual(0);
  });
});
