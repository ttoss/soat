import { db } from 'src/db';
import {
  fireDueTriggers,
  startTriggerScheduler,
  stopTriggerScheduler,
} from 'src/lib/triggerScheduler';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

// The scheduler fires triggers in a detached `void` promise, so after
// fireDueTriggers returns the firing record may not exist yet. Polling the DB
// (no timer APIs) yields to the event loop and lets that background work run.
const waitForTerminalFiring = async (
  triggerInternalId: number,
  statuses: string[] = ['succeeded', 'failed']
): Promise<InstanceType<typeof db.TriggerFiring>> => {
  for (let i = 0; i < 3000; i += 1) {
    const firing = await db.TriggerFiring.findOne({
      where: { triggerId: triggerInternalId },
      order: [['createdAt', 'DESC']],
    });
    if (firing && statuses.includes(firing.status as string)) return firing;
  }
  throw new Error(
    `trigger ${triggerInternalId} never produced a ${statuses.join('/')} firing`
  );
};

const flush = () => {
  return new Promise<void>((resolve) => {
    return setImmediate(resolve);
  });
};

// ── Real-DB fixtures ──────────────────────────────────────────────────────
//
// The scheduler is a real entry point, so these tests drive fireDueTriggers
// against the real database. Schedule triggers are created through the REST API
// (so the run-as creator and its StartRun permission are wired exactly as in
// production), then their `nextFireAt` is manipulated directly to model the due
// / future / misfired states the scheduler reclaims.

let userToken: string;
let projectPublicId: string;
let orchestrationId: string;

let triggerSeq = 0;

const PAST = () => {
  return new Date(Date.now() - 60_000);
};

// Creates a schedule trigger via the API (orchestration target — no LLM
// boundary needed), returning both the public and internal ids.
const createScheduleTrigger = async (args?: {
  cron?: string;
}): Promise<{ publicId: string; internalId: number }> => {
  triggerSeq += 1;
  const res = await authenticatedTestClient(userToken)
    .post('/api/v1/triggers')
    .send({
      project_id: projectPublicId,
      name: `sched-${triggerSeq}`,
      type: 'schedule',
      target_type: 'orchestration',
      target_id: orchestrationId,
      cron: args?.cron ?? '0 8 * * *',
    });
  expect(res.status).toBe(201);
  const publicId = res.body.id as string;
  const row = await db.Trigger.findOne({ where: { publicId } });
  return { publicId, internalId: row?.id as number };
};

// Directly overrides scheduler-relevant columns to model a specific due state.
const setTriggerColumns = async (
  internalId: number,
  values: Record<string, unknown>
): Promise<void> => {
  await db.Trigger.update(values, { where: { id: internalId } });
};

const countFirings = async (internalId: number): Promise<number> => {
  return db.TriggerFiring.count({ where: { triggerId: internalId } });
};

beforeAll(async () => {
  const setup = await setupProjectWithUsers({
    prefix: 'trgsched',
    policyActions: [
      'triggers:CreateTrigger',
      'orchestrations:CreateOrchestration',
      'orchestrations:StartRun',
    ],
    createNoPermUser: false,
  });
  userToken = setup.userToken;
  projectPublicId = setup.projectId;

  orchestrationId = (
    await authenticatedTestClient(userToken)
      .post('/api/v1/orchestrations')
      .send({
        project_id: projectPublicId,
        name: 'Sched Trigger Orchestration',
        nodes: [
          {
            id: 'start',
            type: 'transform',
            expression: { var: '' },
            state_mapping: { 'state.result': { var: 'output.output' } },
          },
        ],
        edges: [],
      })
  ).body.id as string;
});

describe('triggerScheduler', () => {
  afterEach(() => {
    stopTriggerScheduler();
  });

  describe('fireDueTriggers', () => {
    test('returns 0 when no schedule trigger is due', async () => {
      // Nothing has next_fire_at at or before the epoch.
      const count = await fireDueTriggers({ now: new Date(0) });
      expect(count).toBe(0);
    });

    test('returns 0 and swallows a query failure', async () => {
      // An invalid `now` makes the real `next_fire_at <= now` query fail at the
      // DB, exercising the defensive catch without stubbing `db.*`.
      const count = await fireDueTriggers({ now: new Date('not-a-date') });
      expect(count).toBe(0);
    });

    test('claims a due trigger, advances next_fire_at, and fires it', async () => {
      const { publicId, internalId } = await createScheduleTrigger();
      const dueAt = PAST();
      await setTriggerColumns(internalId, { nextFireAt: dueAt });

      const now = new Date();
      const claimed = await fireDueTriggers({ now });
      expect(claimed).toBeGreaterThanOrEqual(1);

      // next_fire_at was advanced to the next occurrence computed from now.
      const advanced = await db.Trigger.findOne({ where: { publicId } });
      const nextFireAt = advanced?.nextFireAt as Date;
      expect(nextFireAt.getTime()).toBeGreaterThan(now.getTime());

      // The firing was created with source 'schedule' and reaches a terminal
      // state (orchestration target runs synchronously to completion).
      await flush();
      const firing = await waitForTerminalFiring(internalId);
      expect(firing.source).toBe('schedule');
      expect(firing.status).toBe('succeeded');
      expect(await countFirings(internalId)).toBe(1);
    });

    test('does not fire an inactive schedule trigger', async () => {
      const { internalId } = await createScheduleTrigger();
      await setTriggerColumns(internalId, {
        nextFireAt: PAST(),
        active: false,
      });

      await fireDueTriggers({ now: new Date() });
      await flush();
      expect(await countFirings(internalId)).toBe(0);
    });

    test('does not fire a non-schedule trigger even when next_fire_at is due', async () => {
      // A manual trigger with a due next_fire_at must be skipped by the
      // type='schedule' filter.
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/triggers')
        .send({
          project_id: projectPublicId,
          name: `manual-due-${(triggerSeq += 1)}`,
          type: 'manual',
          target_type: 'orchestration',
          target_id: orchestrationId,
        });
      expect(res.status).toBe(201);
      const row = await db.Trigger.findOne({
        where: { publicId: res.body.id },
      });
      const internalId = row?.id as number;
      await setTriggerColumns(internalId, { nextFireAt: PAST() });

      await fireDueTriggers({ now: new Date() });
      await flush();
      expect(await countFirings(internalId)).toBe(0);
    });

    test('does not fire a trigger whose next_fire_at is in the future', async () => {
      const { internalId } = await createScheduleTrigger();
      await setTriggerColumns(internalId, {
        nextFireAt: new Date(Date.now() + 3_600_000),
      });

      await fireDueTriggers({ now: new Date() });
      await flush();
      expect(await countFirings(internalId)).toBe(0);
    });

    test('coalesces missed occurrences: advances to the next future occurrence', async () => {
      const { publicId, internalId } = await createScheduleTrigger({
        cron: '*/5 * * * *',
      });
      // Due well in the past — many */5 occurrences were missed while "down".
      await setTriggerColumns(internalId, {
        nextFireAt: new Date(Date.now() - 3 * 3_600_000),
      });

      const now = new Date();
      await fireDueTriggers({ now });

      // A single catch-up fire, with next_fire_at jumped to one future
      // occurrence rather than replaying every missed slot.
      const advanced = await db.Trigger.findOne({ where: { publicId } });
      const nextFireAt = advanced?.nextFireAt as Date;
      expect(nextFireAt.getTime()).toBeGreaterThan(now.getTime());
      // Next */5 occurrence is at most 5 minutes out.
      expect(nextFireAt.getTime()).toBeLessThanOrEqual(now.getTime() + 300_000);

      await flush();
      await waitForTerminalFiring(internalId);
      expect(await countFirings(internalId)).toBe(1);
    });

    test('fires each due trigger exactly once across overlapping ticks', async () => {
      const { internalId } = await createScheduleTrigger();
      await setTriggerColumns(internalId, { nextFireAt: PAST() });

      // Two overlapping sweeps race for the same trigger; the atomic guarded
      // UPDATE (advance only if next_fire_at still equals what we read) plus the
      // in-flight guard let exactly one win.
      const now = new Date();
      await Promise.all([fireDueTriggers({ now }), fireDueTriggers({ now })]);

      await flush();
      await waitForTerminalFiring(internalId);
      expect(await countFirings(internalId)).toBe(1);
    });

    test('skips a trigger whose stored cron is invalid', async () => {
      const { publicId, internalId } = await createScheduleTrigger();
      const dueAt = PAST();
      // Corrupt the cron directly so computeNextFireAt throws in the loop.
      await setTriggerColumns(internalId, {
        cron: 'not a cron',
        nextFireAt: dueAt,
      });

      await fireDueTriggers({ now: new Date() });
      await flush();

      // Not claimed: no firing and next_fire_at unchanged.
      expect(await countFirings(internalId)).toBe(0);
      const after = await db.Trigger.findOne({ where: { publicId } });
      expect((after?.nextFireAt as Date).getTime()).toBe(dueAt.getTime());
    });

    test('skips a schedule trigger with a missing cron', async () => {
      const { internalId } = await createScheduleTrigger();
      await setTriggerColumns(internalId, {
        cron: null,
        nextFireAt: PAST(),
      });

      await fireDueTriggers({ now: new Date() });
      await flush();
      expect(await countFirings(internalId)).toBe(0);
    });
  });

  describe('startTriggerScheduler', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      stopTriggerScheduler();
      jest.useRealTimers();
    });

    test('drives a due trigger on each interval tick and is idempotent', async () => {
      const { internalId } = await createScheduleTrigger();
      await setTriggerColumns(internalId, { nextFireAt: PAST() });

      startTriggerScheduler({ intervalMs: 5000 });
      // Second call short-circuits because a timer already exists.
      startTriggerScheduler({ intervalMs: 5000 });

      await jest.advanceTimersByTimeAsync(5000);

      // The tick's sweep claimed and fired the trigger.
      await waitForTerminalFiring(internalId);
      expect(await countFirings(internalId)).toBe(1);

      // Once stopped, no leaked timer keeps ticking: a freshly-due trigger is
      // left untouched even after another interval elapses.
      stopTriggerScheduler();
      const { internalId: after } = await createScheduleTrigger();
      await setTriggerColumns(after, { nextFireAt: PAST() });
      await jest.advanceTimersByTimeAsync(5000);
      expect(await countFirings(after)).toBe(0);
    });

    test('falls back to the default interval for an invalid override', async () => {
      const { internalId } = await createScheduleTrigger();
      await setTriggerColumns(internalId, { nextFireAt: PAST() });

      startTriggerScheduler({ intervalMs: 0 });

      // Nothing fires before the default 30s interval elapses.
      await jest.advanceTimersByTimeAsync(29_999);
      expect(await countFirings(internalId)).toBe(0);

      // One tick past the default interval → the sweep claims and fires it.
      await jest.advanceTimersByTimeAsync(1);
      await waitForTerminalFiring(internalId);
      expect(await countFirings(internalId)).toBe(1);
    });

    test('does not start when disabled via env', async () => {
      const { internalId } = await createScheduleTrigger();
      await setTriggerColumns(internalId, { nextFireAt: PAST() });

      const prev = process.env.SOAT_TRIGGER_SCHEDULER_DISABLED;
      process.env.SOAT_TRIGGER_SCHEDULER_DISABLED = 'true';
      try {
        startTriggerScheduler({ intervalMs: 5000 });
        await jest.advanceTimersByTimeAsync(5000);
        expect(await countFirings(internalId)).toBe(0);
      } finally {
        if (prev === undefined) {
          delete process.env.SOAT_TRIGGER_SCHEDULER_DISABLED;
        } else {
          process.env.SOAT_TRIGGER_SCHEDULER_DISABLED = prev;
        }
      }
    });
  });
});
