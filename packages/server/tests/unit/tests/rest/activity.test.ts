import { db } from 'src/db';
import { emitActivityEntry } from 'src/lib/activity';
import { emitApproval as emitApprovalLib } from 'src/lib/approvals';
import { droppedEventCount } from 'src/lib/eventBus';
import { fileException } from 'src/lib/exceptions';
import { fireDueTriggers } from 'src/lib/triggerScheduler';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

// No public create endpoint — entries are platform-written by producers. Shape
// and filter coverage seeds via `emitActivityEntry` (the sanctioned "no entry
// point" path); each real producer is then exercised end-to-end.

describe('Activity', () => {
  let adminToken: string;
  let userToken: string;
  let noPermToken: string;
  let projectId: string;
  let projectInternalId: number;
  let otherProjectId: string;

  const listActivity = async (query: string) => {
    return authenticatedTestClient(userToken).get(
      `/api/v1/activity?project_id=${projectId}${query}`
    );
  };

  // Producers write fire-and-forget off an event or a direct call, so poll the
  // observable side effect rather than racing it (mirrors exceptions.test.ts).
  const waitForActivity = async (
    predicate: (e: { kind: string; ref_id: string | null }) => boolean
  ) => {
    for (let i = 0; i < 100; i += 1) {
      const res = await listActivity('');
      const match = res.body.data.find(predicate);
      if (match) return match;
      await new Promise((resolve) => {
        return setTimeout(resolve, 20);
      });
    }
    return null;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'activity',
      policyActions: [
        'activity:ListActivity',
        'approvals:ResolveApproval',
        'orchestrations:CreateOrchestration',
        'orchestrations:StartRun',
        'triggers:CreateTrigger',
      ],
      createOtherProject: true,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    noPermToken = setup.noPermToken as string;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId as string;
    const project = await db.Project.findOne({
      where: { publicId: projectId },
    });
    projectInternalId = project!.id as number;
  });

  describe('GET /api/v1/activity', () => {
    test('unauthenticated request returns 401', async () => {
      const res = await testClient.get(
        `/api/v1/activity?project_id=${projectId}`
      );
      expect(res.status).toBe(401);
    });

    test('user without permission gets 403', async () => {
      const res = await authenticatedTestClient(noPermToken).get(
        `/api/v1/activity?project_id=${projectId}`
      );
      expect(res.status).toBe(403);
    });

    // An admin JWT with no project_id resolves to `undefined` (no single
    // project to scope to), which the route falls back to an empty project
    // list for — rather than an unbounded cross-project query.
    test('admin with no project_id sees an empty, not unbounded, list', async () => {
      const res =
        await authenticatedTestClient(adminToken).get('/api/v1/activity');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.next_cursor).toBeNull();
    });

    test('lists entries with the full shape', async () => {
      const entry = await emitActivityEntry({
        projectId: projectInternalId,
        kind: 'action_executed',
        summary: 'Tool executed',
        detail: { toolId: 'tool_abc' },
        orchestrationRunId: 'orch_run_seed0000000',
        agentId: 'agent_seed00000000',
        refId: 'tool_abc',
      });

      const res = await listActivity('');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      const found = res.body.data.find((e: { id: string }) => {
        return e.id === entry!.id;
      });
      expect(found).toBeDefined();
      expect(found.id).toMatch(/^acte_/);
      expect(found.project_id).toBe(projectId);
      expect(found.kind).toBe('action_executed');
      expect(found.severity).toBe('info');
      expect(found.summary).toBe('Tool executed');
      expect(found.detail).toEqual({ tool_id: 'tool_abc' });
      expect(found.orchestration_run_id).toBe('orch_run_seed0000000');
      expect(found.agent_id).toBe('agent_seed00000000');
      expect(found.ref_id).toBe('tool_abc');
      expect(found.created_at).toBeDefined();
    });

    test('a non-numeric limit falls back to the default rather than erroring', async () => {
      const res = await listActivity('&limit=not-a-number');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    test('filters by kind', async () => {
      await emitActivityEntry({
        projectId: projectInternalId,
        kind: 'schedule_fired',
        summary: 'kind-filter-probe',
      });

      const res = await listActivity('&kind=schedule_fired');
      expect(res.status).toBe(200);
      expect(
        res.body.data.every((e: { kind: string }) => {
          return e.kind === 'schedule_fired';
        })
      ).toBe(true);
      expect(
        res.body.data.some((e: { summary: string }) => {
          return e.summary === 'kind-filter-probe';
        })
      ).toBe(true);
    });

    test('filters by severity', async () => {
      await emitActivityEntry({
        projectId: projectInternalId,
        kind: 'action_executed',
        summary: 'severity-filter-probe',
        severity: 'critical',
      });

      const res = await listActivity('&severity=critical');
      expect(res.status).toBe(200);
      expect(
        res.body.data.every((e: { severity: string }) => {
          return e.severity === 'critical';
        })
      ).toBe(true);
      expect(
        res.body.data.some((e: { summary: string }) => {
          return e.summary === 'severity-filter-probe';
        })
      ).toBe(true);
    });

    test("an entry scoped to another project never leaks into this project's list", async () => {
      const otherProject = await db.Project.findOne({
        where: { publicId: otherProjectId },
      });
      const otherEntry = await emitActivityEntry({
        projectId: otherProject!.id as number,
        kind: 'action_executed',
        summary: 'other-project-probe',
      });

      const res = await listActivity('');
      expect(res.status).toBe(200);
      expect(
        res.body.data.some((e: { id: string }) => {
          return e.id === otherEntry!.id;
        })
      ).toBe(false);
    });

    test('cursor pagination walks the full set with no duplicates and terminates', async () => {
      for (let i = 0; i < 3; i += 1) {
        await emitActivityEntry({
          projectId: projectInternalId,
          kind: 'action_executed',
          summary: `page-probe-${i}`,
        });
      }

      const seenIds = new Set<string>();
      let cursor: string | undefined;
      let pages = 0;
      for (let i = 0; i < 50; i += 1) {
        const res = await listActivity(
          `&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
        );
        expect(res.status).toBe(200);
        expect(res.body.data.length).toBeLessThanOrEqual(1);
        for (const e of res.body.data as { id: string }[]) {
          expect(seenIds.has(e.id)).toBe(false);
          seenIds.add(e.id);
        }
        pages += 1;
        if (!res.body.next_cursor) break;
        cursor = res.body.next_cursor;
      }
      // At least the 3 page-probe entries plus the earlier seeded ones.
      expect(seenIds.size).toBeGreaterThanOrEqual(3);
      expect(pages).toBeLessThan(50);
    });

    test('a cursor with no separator returns 400', async () => {
      const res = await listActivity('&cursor=not-a-real-cursor');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ACTIVITY_INVALID_CURSOR');
    });

    test('a cursor with a separator but an invalid timestamp returns 400', async () => {
      const malformed = Buffer.from(
        'not-a-date|acte_something',
        'utf8'
      ).toString('base64url');
      const res = await listActivity(
        `&cursor=${encodeURIComponent(malformed)}`
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ACTIVITY_INVALID_CURSOR');
    });

    // Force-failure stub for the swallow branch: `emitActivityEntry`'s write
    // is fire-and-forget and must never throw even if the DB insert itself
    // fails, so the failure has to be injected — no real DB write fails
    // deterministically (sanctioned in tests.md for exactly this shape).
    test('emitActivityEntry returns null once a write failure outlives its retries', async () => {
      // Not `…Once`: a single rejection is retried and the entry written after
      // all (#1130), so only a failure persisting across every attempt reaches
      // the null-returning branch.
      const spy = jest
        .spyOn(db.ActivityEntry, 'create')
        .mockRejectedValue(new Error('simulated write failure'));
      const before = droppedEventCount({ stage: 'activity_write' });
      try {
        const result = await emitActivityEntry({
          projectId: projectInternalId,
          kind: 'action_executed',
          summary: 'should not persist',
        });
        expect(result).toBeNull();
        expect(droppedEventCount({ stage: 'activity_write' })).toBe(before + 1);
      } finally {
        spy.mockRestore();
      }
    });

    test('emitActivityEntry survives a transient write failure', async () => {
      const spy = jest
        .spyOn(db.ActivityEntry, 'create')
        .mockRejectedValueOnce(new Error('connection terminated'));
      try {
        const result = await emitActivityEntry({
          projectId: projectInternalId,
          kind: 'action_executed',
          summary: 'written on the retry',
        });
        expect(result).not.toBeNull();
        expect(result!.summary).toBe('written on the retry');
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('producer wiring', () => {
    test('approval_resolved is written when an approval is approved', async () => {
      const seeded = await emitApprovalLib({
        projectId: projectInternalId,
        proposedAction: {
          toolId: 'tool_activityseed0',
          arguments: { amount: 10 },
        },
        reasoning: 'activity wiring test',
        expiresInSeconds: 3600,
      });

      const approveRes = await authenticatedTestClient(userToken)
        .post(`/api/v1/approvals/${seeded.id}/approve`)
        .send({});
      expect(approveRes.status).toBe(200);

      const found = await waitForActivity((e) => {
        return e.kind === 'approval_resolved' && e.ref_id === seeded.id;
      });
      expect(found).toBeTruthy();
      expect(found.project_id).toBe(projectId);
    });

    test('exception_created is written when an exception is filed', async () => {
      const exception = await fileException({
        projectId: projectInternalId,
        kind: 'manual',
        title: 'activity wiring test exception',
      });

      const found = await waitForActivity((e) => {
        return e.kind === 'exception_created' && e.ref_id === exception.id;
      });
      expect(found).toBeTruthy();
      expect(found.project_id).toBe(projectId);
    });

    // `manual` defaults to the same `warning` the activity kind does, so it
    // cannot tell inheritance from the default. `run_failed` defaults to
    // `critical`, which is otherwise unreachable through any producer.
    test('exception_created inherits the exception severity', async () => {
      const exception = await fileException({
        projectId: projectInternalId,
        kind: 'run_failed',
        title: 'activity severity inheritance test',
      });
      expect(exception.severity).toBe('critical');

      const found = await waitForActivity((e) => {
        return e.kind === 'exception_created' && e.ref_id === exception.id;
      });
      expect(found).toBeTruthy();
      expect(found.severity).toBe('critical');
    });

    test('schedule_fired is written when a schedule trigger fires', async () => {
      const orchRes = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          project_id: projectId,
          name: `activity-orch-${Date.now()}`,
          nodes: [{ id: 'start', type: 'transform', expression: 'done' }],
          edges: [],
        });
      expect(orchRes.status).toBe(201);

      const trgRes = await authenticatedTestClient(userToken)
        .post('/api/v1/triggers')
        .send({
          project_id: projectId,
          name: `activity-trg-${Date.now()}`,
          type: 'schedule',
          target_type: 'orchestration',
          target_id: orchRes.body.id,
          cron: '0 8 * * *',
        });
      expect(trgRes.status).toBe(201);

      const triggerRow = await db.Trigger.findOne({
        where: { publicId: trgRes.body.id },
      });
      await db.Trigger.update(
        { nextFireAt: new Date(Date.now() - 60_000) },
        { where: { id: triggerRow!.id as number } }
      );

      await fireDueTriggers();

      const found = await waitForActivity((e) => {
        return e.kind === 'schedule_fired' && e.ref_id === trgRes.body.id;
      });
      expect(found).toBeTruthy();
      expect(found.project_id).toBe(projectId);
    });
  });
});
