import { db } from 'src/db';
import * as auditLog from 'src/lib/auditLog';
import {
  flushAuditQueue,
  getDroppedAuditCount,
  resetAuditQueue,
} from 'src/lib/auditQueue';
import { runRetentionSweep } from 'src/lib/auditScheduler';
import { eventBus, type SoatEvent } from 'src/lib/eventBus';
import type { GuardrailEvaluationRecord } from 'src/lib/guardrailEvaluationRecord';
import { persistGuardrailEvaluations } from 'src/lib/guardrailEvaluationRecord';

import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { assertGuardrailEvaluationDetail } from '../../fixtures/guardrailEvaluationDetail';
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
      'tools:UpdateTool',
      'tools:DeleteTool',
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
    expect(create.principal_type).toBe('user');
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

describe('Audit Log — item-scoped mutations authorized via resolveProjectIds (no explicit project_id)', () => {
  // `PATCH`/`DELETE /tools/:tool_id` authorize with `resolveProjectIds({ action,
  // resourceType })` — no `projectPublicId` argument, since the route does not
  // know which project the target belongs to until the lib layer resolves it.
  // Regression coverage for the bug where such routes wrote no audit entry at
  // all (github.com/ttoss/soat/issues/689): update and delete must each be
  // recorded, scoped to the tool's actual project, with a precise resource SRN.
  test('updating a tool by id yields a tools:UpdateTool entry scoped to its project', async () => {
    const createRes = await authenticatedTestClient(userToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'audit-item-scoped-update',
        type: 'http',
        execute: { url: 'https://example.com/hook', method: 'POST' },
      });
    expect(createRes.status).toBe(201);
    const toolId = createRes.body.id as string;

    const updateRes = await authenticatedTestClient(userToken)
      .patch(`/api/v1/tools/${toolId}`)
      .send({ description: 'renamed by test' });
    expect(updateRes.status).toBe(200);

    const entries = await listEntries({ resource_public_id: toolId });
    const updated = entries.find((e) => {
      return e.action === 'tools:UpdateTool';
    });
    expect(updated).toBeDefined();
    expect(updated!.status).toBe(200);
    expect(updated!.project_id).toBe(projectId);
    expect(updated!.resource_srn).toBe(`soat:${projectId}:tool:${toolId}`);
    expect(updated!.principal_type).toBe('user');
  });

  test('deleting a tool by id yields a tools:DeleteTool entry scoped to its project', async () => {
    const createRes = await authenticatedTestClient(userToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'audit-item-scoped-delete',
        type: 'http',
        execute: { url: 'https://example.com/hook', method: 'POST' },
      });
    expect(createRes.status).toBe(201);
    const toolId = createRes.body.id as string;

    const deleteRes = await authenticatedTestClient(userToken).delete(
      `/api/v1/tools/${toolId}`
    );
    expect(deleteRes.status).toBe(204);

    const entries = await listEntries({ resource_public_id: toolId });
    const deleted = entries.find((e) => {
      return e.action === 'tools:DeleteTool';
    });
    expect(deleted).toBeDefined();
    expect(deleted!.status).toBe(204);
    expect(deleted!.project_id).toBe(projectId);
    expect(deleted!.resource_srn).toBe(`soat:${projectId}:tool:${toolId}`);
    expect(deleted!.principal_type).toBe('user');
  });

  test('a denied update on a route with no explicit project_id still yields a 403 entry', async () => {
    const createRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'audit-item-scoped-denied',
        type: 'http',
        execute: { url: 'https://example.com/hook', method: 'POST' },
      });
    const toolId = createRes.body.id as string;

    // A plain JWT user with zero policies resolves to an *empty* accessible-
    // project set (not a `null`/403 decision — see `resolveProjectIdsByPublicIdAndPolicy`),
    // so the lib layer 404s instead of denying. A project-scoped API key whose
    // policy excludes `tools:UpdateTool` genuinely denies via
    // `resolveApiKeyScopedProjectIds`, producing the real 403 this test needs.
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
        name: 'audit-tools-no-perm-key',
        project_id: projectId,
        policy_ids: [policyRes.body.id],
      });
    const rawKey = keyRes.body.key as string;

    const updateRes = await authenticatedTestClient(rawKey)
      .patch(`/api/v1/tools/${toolId}`)
      .send({ description: 'should be denied' });
    expect(updateRes.status).toBe(403);

    const entries = await listEntries({ resource_public_id: toolId });
    const denied = entries.find((e) => {
      return e.action === 'tools:UpdateTool' && e.status === 403;
    });
    expect(denied).toBeDefined();
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

  test('?from=/?to= bound results by createdAt', async () => {
    // A wide window (valid ISO dates) returns entries.
    const within = await listEntries({
      from: '2000-01-01T00:00:00.000Z',
      to: '2999-01-01T00:00:00.000Z',
    });
    expect(within.length).toBeGreaterThan(0);

    // A future-only lower bound excludes every existing entry.
    const future = await listEntries({ from: '2999-01-01T00:00:00.000Z' });
    expect(future).toHaveLength(0);
  });

  // Regression coverage for github.com/ttoss/soat/issues/691: an unparseable
  // `from`/`to` used to be silently dropped rather than applied, so a typo
  // widened a compliance query into "every entry" instead of failing loudly.
  test('an unparseable ?from= is rejected with 400, not silently dropped', async () => {
    await flushAuditQueue();
    const res = await authenticatedTestClient(adminToken)
      .get('/api/v1/audit-log')
      .query({ project_id: projectId, from: 'not-a-real-date' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  test('an unparseable ?to= is rejected with 400, not silently dropped', async () => {
    await flushAuditQueue();
    const res = await authenticatedTestClient(adminToken)
      .get('/api/v1/audit-log')
      .query({ project_id: projectId, to: 'also-not-a-date' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  test('the export endpoint rejects an unparseable ?from= the same way', async () => {
    const res = await authenticatedTestClient(adminToken)
      .get('/api/v1/audit-log/export')
      .query({ project_id: projectId, from: 'not-a-real-date' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  test('an absent ?from=/?to= is simply unfiltered, not an error', async () => {
    const res = await authenticatedTestClient(adminToken)
      .get('/api/v1/audit-log')
      .query({ project_id: projectId });
    expect(res.status).toBe(200);
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

  // Regression coverage for github.com/ttoss/soat/issues/707: a non-numeric
  // `limit`/`offset` used to reach Sequelize as `NaN` and crash with a bare
  // 500, instead of failing loudly like the `from`/`to` date params do.
  test('a non-numeric ?limit= is rejected with 400, not a 500', async () => {
    const res = await authenticatedTestClient(adminToken)
      .get('/api/v1/audit-log')
      .query({ project_id: projectId, limit: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  test('a non-numeric ?offset= is rejected with 400, not a 500', async () => {
    const res = await authenticatedTestClient(adminToken)
      .get('/api/v1/audit-log')
      .query({ project_id: projectId, offset: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  test('?limit=NaN is rejected with 400, not a 500', async () => {
    const res = await authenticatedTestClient(adminToken)
      .get('/api/v1/audit-log')
      .query({ project_id: projectId, limit: 'NaN' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  test('an absent ?limit=/?offset= still falls back to the default, not an error', async () => {
    const res = await authenticatedTestClient(adminToken)
      .get('/api/v1/audit-log')
      .query({ project_id: projectId });
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(25);
    expect(res.body.offset).toBe(0);
  });

  test('out-of-range numeric limit/offset still clamp instead of erroring', async () => {
    const res = await authenticatedTestClient(adminToken)
      .get('/api/v1/audit-log')
      .query({ project_id: projectId, limit: '0', offset: '-10' });
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(1);
    expect(res.body.offset).toBe(0);
  });
});

describe('Audit Log — guardrail_evaluation detail kind (audit-log P2)', () => {
  // A minimal evaluation record for a given decision; the production
  // persistGuardrailEvaluations helper is the shared choke point that mirrors
  // decision-changing records into the audit log.
  const record = (
    guardrailId: string,
    decision: GuardrailEvaluationRecord['decision']
  ): GuardrailEvaluationRecord => {
    return {
      kind: 'guardrail_evaluation',
      guardrailId,
      guardrailVersion: 1,
      scope: 'tool',
      tool: 'refund',
      action: 'refund',
      class: decision === 'blocked' ? 'D' : 'B',
      decision,
      guardResult: decision === 'tripwire' ? false : null,
      contextSource: 'none',
      contextSnapshot: {},
      agentId: null,
      runId: null,
      generationId: null,
    };
  };

  const internalProjectId = async (): Promise<number> => {
    const project = await db.Project.findOne({
      where: { publicId: projectId },
    });
    return project!.id;
  };

  test('a decision-changing evaluation surfaces as a guardrail_evaluation entry, snake-cased through the API', async () => {
    const guardrailId = 'guard_auditp2block0';
    await persistGuardrailEvaluations({
      projectId: await internalProjectId(),
      records: [record(guardrailId, 'blocked')],
    });

    const entries = await listEntries({ action: 'guardrails:Evaluate' });
    const entry = entries.find((e) => {
      return e.resource_public_id === guardrailId;
    });
    expect(entry).toBeDefined();
    // Platform-originated: identified by its action, never a fabricated actor.
    expect(entry!.principal_type).toBeNull();
    expect(entry!.principal_id).toBeNull();
    expect(entry!.resource_srn).toBe(
      `soat:${projectId}:guardrail:${guardrailId}`
    );
    // The read endpoint snake-cases the detail payload; assert it against the
    // shared schema fixture so the guardrails kind and the audit PRD can't drift.
    assertGuardrailEvaluationDetail(entry!.detail, 'snake');
    const detail = entry!.detail as Record<string, unknown>;
    expect(detail.decision).toBe('blocked');
    expect(detail.guardrail_id).toBe(guardrailId);
  });

  test('a plain execute evaluation writes no audit entry (selective-write boundary)', async () => {
    const guardrailId = 'guard_auditp2exec00';
    await persistGuardrailEvaluations({
      projectId: await internalProjectId(),
      records: [record(guardrailId, 'execute')],
    });

    const entries = await listEntries({ action: 'guardrails:Evaluate' });
    expect(
      entries.find((e) => {
        return e.resource_public_id === guardrailId;
      })
    ).toBeUndefined();
  });
});

describe('Audit Log — read auditing flag (audit-log P3)', () => {
  // A dedicated project so enabling read auditing here never pollutes the
  // write-hook tests above. Assertions key on `request_id` rather than entry
  // counts: with the flag on, the `listEntries` helper's own project-scoped GET
  // is itself audited, so counts are not stable.
  let readProjectId: string;
  let readSecretId: string;

  const setReadAuditing = async (enabled: boolean) => {
    const res = await authenticatedTestClient(adminToken)
      .patch(`/api/v1/projects/${readProjectId}`)
      .send({ audit_reads_enabled: enabled });
    expect(res.status).toBe(200);
    expect(res.body.audit_reads_enabled).toBe(enabled);
  };

  /** The entry written for the request that returned `requestId`, if any. */
  const entryForRequest = async (
    requestId: string
  ): Promise<Record<string, unknown> | undefined> => {
    const entries = await listEntries();
    return entries.find((e) => {
      return e.request_id === requestId;
    });
  };

  beforeAll(async () => {
    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: `${P} Read Audit Project` });
    readProjectId = projectRes.body.id as string;

    const secretRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/secrets')
      .send({ project_id: readProjectId, name: 'READ_AUDIT', value: 'v' });
    expect(secretRes.status).toBe(201);
    readSecretId = secretRes.body.id as string;
  });

  afterAll(async () => {
    // Leave the flag off so later tests are unaffected by the opt-in.
    await setReadAuditing(false);
  });

  test('a project defaults to audit_reads_enabled false', async () => {
    const res = await authenticatedTestClient(adminToken).get(
      `/api/v1/projects/${readProjectId}`
    );
    expect(res.status).toBe(200);
    expect(res.body.audit_reads_enabled).toBe(false);
  });

  test('with the flag off, a project-scoped GET writes no entry', async () => {
    await setReadAuditing(false);

    const res = await authenticatedTestClient(adminToken).get(
      `/api/v1/secrets/${readSecretId}`
    );
    expect(res.status).toBe(200);

    expect(await entryForRequest(res.headers['x-request-id'])).toBeUndefined();
  });

  test('with the flag on, a project-scoped GET writes one entry with the read action', async () => {
    await setReadAuditing(true);

    const res = await authenticatedTestClient(adminToken).get(
      `/api/v1/secrets/${readSecretId}`
    );
    expect(res.status).toBe(200);

    const entry = await entryForRequest(res.headers['x-request-id']);
    expect(entry).toBeDefined();
    expect(entry!.action).toBe('secrets:GetSecret');
    expect(entry!.status).toBe(200);
    expect(entry!.resource_srn).toBe(
      `soat:${readProjectId}:secret:${readSecretId}`
    );
    expect(entry!.resource_public_id).toBe(readSecretId);
    expect(entry!.principal_type).toBe('user');
    expect(entry!.project_id).toBe(readProjectId);
  });

  test('a list GET naming the project is audited when the flag is on', async () => {
    await setReadAuditing(true);

    const res = await authenticatedTestClient(adminToken)
      .get('/api/v1/secrets')
      .query({ project_id: readProjectId });
    expect(res.status).toBe(200);

    const entry = await entryForRequest(res.headers['x-request-id']);
    expect(entry).toBeDefined();
    expect(entry!.action).toBe('secrets:ListSecrets');
    expect(entry!.status).toBe(200);
  });

  test('one project’s flag never audits reads of another project', async () => {
    await setReadAuditing(true);

    const secretRes = await authenticatedTestClient(userToken)
      .post('/api/v1/secrets')
      .send({ project_id: projectId, name: 'READ_ISOLATION', value: 'v' });
    const otherSecretId = secretRes.body.id as string;

    // A read in the *main* project (flag off) while the read-audit project is on.
    const res = await authenticatedTestClient(userToken).get(
      `/api/v1/secrets/${otherSecretId}`
    );
    expect(res.status).toBe(200);

    expect(await entryForRequest(res.headers['x-request-id'])).toBeUndefined();
  });

  test('turning the flag back off stops recording reads', async () => {
    await setReadAuditing(true);
    const on = await authenticatedTestClient(adminToken).get(
      `/api/v1/secrets/${readSecretId}`
    );
    expect(await entryForRequest(on.headers['x-request-id'])).toBeDefined();

    await setReadAuditing(false);
    const off = await authenticatedTestClient(adminToken).get(
      `/api/v1/secrets/${readSecretId}`
    );
    expect(await entryForRequest(off.headers['x-request-id'])).toBeUndefined();
  });

  test('a read that names no project is never audited, even with a flag on', async () => {
    await setReadAuditing(true);

    // Unscoped list enumeration: no project is named, so there is no project
    // whose flag could opt the read in.
    const res =
      await authenticatedTestClient(adminToken).get('/api/v1/secrets');
    expect(res.status).toBe(200);

    expect(await entryForRequest(res.headers['x-request-id'])).toBeUndefined();
  });
});

describe('Audit Log — audit.entry_created webhook (audit-log P3)', () => {
  const captureEvents = async (
    act: () => Promise<void>
  ): Promise<SoatEvent[]> => {
    const captured: SoatEvent[] = [];
    const handler = (event: SoatEvent) => {
      if (event.type === 'audit.entry_created') captured.push(event);
    };
    eventBus.on('soat:event', handler);
    try {
      await act();
      await flushAuditQueue();
    } finally {
      // Never leak a listener onto the shared bus (tests.md).
      eventBus.off('soat:event', handler);
    }
    return captured;
  };

  test('a project-scoped entry emits audit.entry_created with the entry payload', async () => {
    let secretId = '';
    const events = await captureEvents(async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/secrets')
        .send({ project_id: projectId, name: 'AUDIT_WEBHOOK', value: 'v' });
      expect(res.status).toBe(201);
      secretId = res.body.id as string;
    });

    const event = events.find((e) => {
      return e.data.resource_public_id === secretId;
    });
    expect(event).toBeDefined();
    expect(event!.resourceType).toBe('audit');
    expect(event!.projectPublicId).toBe(projectId);
    // The event id is the entry's public id, and the payload mirrors the
    // snake_case read contract so a SIEM consumer needs no follow-up GET.
    expect(String(event!.resourceId).startsWith('audit_')).toBe(true);
    expect(event!.data.id).toBe(event!.resourceId);
    expect(event!.data.action).toBe('secrets:CreateSecret');
    expect(event!.data.status).toBe(201);
    expect(event!.data.principal_type).toBe('user');
    expect(event!.data.project_id).toBe(projectId);
    expect(event!.data.created_at).toBeDefined();
  });

  test('a platform-originated entry emits the event too, with null principal', async () => {
    const guardrailId = 'guard_auditwebhook0';
    const project = await db.Project.findOne({
      where: { publicId: projectId },
    });

    const events = await captureEvents(async () => {
      await persistGuardrailEvaluations({
        projectId: project!.id as number,
        records: [
          {
            kind: 'guardrail_evaluation',
            guardrailId,
            guardrailVersion: 1,
            scope: 'tool',
            tool: 'refund',
            action: 'refund',
            class: 'D',
            decision: 'blocked',
            guardResult: null,
            contextSource: 'none',
            contextSnapshot: {},
            agentId: null,
            runId: null,
            generationId: null,
          },
        ],
      });
    });

    const event = events.find((e) => {
      return e.data.resource_public_id === guardrailId;
    });
    expect(event).toBeDefined();
    expect(event!.data.action).toBe('guardrails:Evaluate');
    expect(event!.data.principal_type).toBeNull();
    expect(event!.data.principal_id).toBeNull();
    // The webhook payload documents itself as "the same snake_case shape the
    // read API returns" (audit-log.md) — `detail`'s inner keys must be
    // snake_case here too, not just the entry's top-level fields.
    assertGuardrailEvaluationDetail(event!.data.detail, 'snake');
  });

  test('a global (project-less) entry emits no event — webhooks are project-scoped', async () => {
    const events = await captureEvents(async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/users')
        .send({ username: `${P}globalentry`, password: 'globalpass' });
      expect(res.status).toBe(201);
    });

    expect(
      events.find((e) => {
        return e.data.action === 'users:CreateUser';
      })
    ).toBeUndefined();
  });
});

describe('Audit Log — NDJSON export (audit-log P3)', () => {
  /**
   * Reads the export as raw text. The response is `application/x-ndjson`, which
   * superagent does not parse, so the body is buffered and decoded by hand.
   */
  const exportNdjson = async (args: {
    token: string;
    query: Record<string, string>;
  }) => {
    const res = await authenticatedTestClient(args.token)
      .get('/api/v1/audit-log/export')
      .query(args.query)
      .buffer(true)
      .parse((response, callback) => {
        let text = '';
        response.on('data', (chunk: Buffer) => {
          text += chunk.toString('utf8');
        });
        response.on('end', () => {
          callback(null, text);
        });
      });
    return res;
  };

  const parseLines = (body: unknown): Array<Record<string, unknown>> => {
    return String(body)
      .split('\n')
      .filter((line) => {
        return line.trim().length > 0;
      })
      .map((line) => {
        return JSON.parse(line) as Record<string, unknown>;
      });
  };

  test('exports the project’s entries as one snake_case JSON object per line', async () => {
    const createRes = await authenticatedTestClient(userToken)
      .post('/api/v1/secrets')
      .send({ project_id: projectId, name: 'AUDIT_EXPORT', value: 'v' });
    const secretId = createRes.body.id as string;
    await flushAuditQueue();

    const res = await exportNdjson({
      token: adminToken,
      query: { project_id: projectId },
    });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    expect(res.headers['content-disposition']).toContain('attachment');

    const lines = parseLines(res.body);
    expect(lines.length).toBeGreaterThan(0);
    const entry = lines.find((l) => {
      return l.resource_public_id === secretId;
    });
    expect(entry).toBeDefined();
    // snake_case contract, same field set as the read API.
    expect(entry!.action).toBe('secrets:CreateSecret');
    expect(entry!.project_id).toBe(projectId);
    expect(entry!.created_at).toBeDefined();
    expect(entry!.resource_srn).toBeDefined();
    // Every line belongs to the requested project.
    for (const line of lines) {
      expect(line.project_id).toBe(projectId);
    }
  });

  test('filters apply to the export the same way they apply to the list', async () => {
    const res = await exportNdjson({
      token: adminToken,
      query: { project_id: projectId, action: 'secrets:DeleteSecret' },
    });
    expect(res.status).toBe(200);

    const lines = parseLines(res.body);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.action).toBe('secrets:DeleteSecret');
    }
  });

  test('a guardrail_evaluation entry exports with snake_case detail keys', async () => {
    const guardrailId = 'guard_auditexport00';
    const project = await db.Project.findOne({
      where: { publicId: projectId },
    });
    await persistGuardrailEvaluations({
      projectId: project!.id as number,
      records: [
        {
          kind: 'guardrail_evaluation',
          guardrailId,
          guardrailVersion: 1,
          scope: 'tool',
          tool: 'refund',
          action: 'refund',
          class: 'D',
          decision: 'blocked',
          guardResult: null,
          contextSource: 'none',
          contextSnapshot: {},
          agentId: null,
          runId: null,
          generationId: null,
        },
      ],
    });
    await flushAuditQueue();

    const res = await exportNdjson({
      token: adminToken,
      query: { project_id: projectId, resource_public_id: guardrailId },
    });
    expect(res.status).toBe(200);

    const lines = parseLines(res.body);
    const entry = lines.find((l) => {
      return l.resource_public_id === guardrailId;
    });
    expect(entry).toBeDefined();
    // The export documents itself as "the same fields as the read API"
    // (audit-log.md) — `detail`'s inner keys must be snake_case here too.
    assertGuardrailEvaluationDetail(entry!.detail, 'snake');
  });

  test('paginates past the internal batch size without dropping or duplicating rows', async () => {
    // The exporter pages the table internally; assert every id is unique and
    // the count matches what the list endpoint reports as the total.
    const listRes = await authenticatedTestClient(adminToken)
      .get('/api/v1/audit-log')
      .query({ project_id: projectId, limit: '1' });
    const total = listRes.body.total as number;

    const res = await exportNdjson({
      token: adminToken,
      query: { project_id: projectId },
    });
    const lines = parseLines(res.body);
    const ids = new Set(
      lines.map((l) => {
        return l.id as string;
      })
    );
    expect(ids.size).toBe(lines.length);
    expect(lines.length).toBe(total);
  });

  test('project_id is required', async () => {
    const res = await exportNdjson({ token: adminToken, query: {} });
    expect(res.status).toBe(400);
  });

  test('unauthenticated export returns 401', async () => {
    const res = await testClient
      .get('/api/v1/audit-log/export')
      .query({ project_id: projectId });
    expect(res.status).toBe(401);
  });

  test('a user without audit:ExportAuditEntries gets 403', async () => {
    // `userToken` holds audit:ListAuditEntries / audit:GetAuditEntry but not
    // the export action — export is a bulk egress path and is granted separately.
    const res = await exportNdjson({
      token: userToken,
      query: { project_id: projectId },
    });
    expect(res.status).toBe(403);
  });

  test('a user with audit:ExportAuditEntries can export', async () => {
    const exportToken = await createScopedPrincipal({
      adminToken,
      projectId,
      username: `${P}exporter`,
      actions: ['audit:ExportAuditEntries'],
    });

    const res = await exportNdjson({
      token: exportToken,
      query: { project_id: projectId },
    });
    expect(res.status).toBe(200);
    expect(parseLines(res.body).length).toBeGreaterThan(0);
  });

  test('an export naming an unknown project returns 403', async () => {
    const res = await exportNdjson({
      token: adminToken,
      query: { project_id: 'proj_doesnotexist00' },
    });
    // Project scoping cannot resolve the id, so the request is refused — the
    // same behavior every other project-scoped list endpoint has.
    expect(res.status).toBe(403);
  });
});
