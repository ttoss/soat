import { db } from 'src/db';
import {
  EVENT_FIRING_LEASE_MS,
  failExhaustedEventFirings,
  MAX_EVENT_FIRING_ATTEMPTS,
  reserveEventFiring,
  sweepDueEventFirings,
} from 'src/lib/triggerEventFirings';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

const EVENT_NAME = 'durable.tick';

/**
 * Durability for event firings: the row exists before the dispatch, so a
 * process that dies mid-dispatch leaves something for the sweep to find.
 *
 * The interruption is written rather than caused. Killing the process is what
 * the feature is for, but a test cannot kill the worker it is running in — and
 * it does not need to: what a dead process leaves behind is a row that is
 * still `pending` or `running` with a lease nobody renewed, and that state is
 * exactly reproducible.
 */
describe('durable event firings', () => {
  let userToken: string;
  let projectId: string;
  let inertOrchestrationId: string;
  let triggerSeq = 0;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'durablefire',
      policyActions: [
        'orchestrations:CreateOrchestration',
        'orchestrations:StartRun',
        'triggers:CreateTrigger',
      ],
      createNoPermUser: false,
    });

    userToken = setup.userToken;
    projectId = setup.projectId;

    const orchestration = await authenticatedTestClient(userToken)
      .post('/api/v1/orchestrations')
      .send({
        project_id: projectId,
        name: 'durable-inert',
        nodes: [{ id: 'noop', type: 'transform', expression: 42 }],
        edges: [],
      });
    expect(orchestration.status).toBe(201);
    inertOrchestrationId = orchestration.body.id as string;
  }, 60_000);

  const createEventTrigger = async () => {
    triggerSeq += 1;
    const created = await authenticatedTestClient(userToken)
      .post('/api/v1/triggers')
      .send({
        project_id: projectId,
        name: `durable-${triggerSeq}`,
        type: 'event',
        event_pattern: EVENT_NAME,
        target_type: 'orchestration',
        target_id: inertOrchestrationId,
      });
    expect(created.status).toBe(201);

    const row = await db.Trigger.findOne({
      where: { publicId: created.body.id as string },
    });
    return row!;
  };

  /** A firing whose process went away: claimed once, never finished. */
  const abandonedFiring = async (args: {
    trigger: InstanceType<typeof db.Trigger>;
    eventId: string;
    status?: string;
    attempts?: number;
    causationChain?: string[];
  }) => {
    return db.TriggerFiring.create({
      triggerId: args.trigger.id as number,
      projectId: args.trigger.projectId as number,
      source: 'event',
      status: args.status ?? 'pending',
      input: { event: EVENT_NAME },
      result: null,
      error: null,
      idempotencyKey: `${args.eventId}:${args.trigger.publicId as string}`,
      causationChain: args.causationChain ?? [],
      attempts: args.attempts ?? 1,
      leaseExpiresAt: new Date(Date.now() - EVENT_FIRING_LEASE_MS),
      startedAt: null,
      completedAt: null,
    });
  };

  /** The sweep dispatches in a detached promise, so poll rather than wait. */
  const waitForTerminal = async (firingId: number) => {
    for (let attempt = 0; attempt < 4000; attempt += 1) {
      const firing = await db.TriggerFiring.findOne({
        where: { id: firingId },
      });
      if (firing && ['succeeded', 'failed'].includes(firing.status as string)) {
        return firing;
      }
    }
    throw new Error(`firing ${firingId} never settled`);
  };

  describe('reserving', () => {
    test('the row carries the event key and the chain it dispatches under', async () => {
      const trigger = await createEventTrigger();

      const firing = await reserveEventFiring({
        triggerDbId: trigger.id as number,
        triggerPublicId: trigger.publicId as string,
        projectId: trigger.projectId as number,
        eventId: 'evt-reserve-1',
        input: { event: EVENT_NAME },
        causationChain: ['trg_upstream', trigger.publicId as string],
      });

      expect(firing).not.toBeNull();
      expect(firing!.status).toBe('pending');
      expect(firing!.idempotencyKey).toBe(
        `evt-reserve-1:${trigger.publicId as string}`
      );
      expect(firing!.causationChain).toEqual([
        'trg_upstream',
        trigger.publicId,
      ]);
      expect(firing!.attempts).toBe(1);
      expect(firing!.leaseExpiresAt).not.toBeNull();
    });

    test('the same event reaching the same trigger twice reserves once', async () => {
      const trigger = await createEventTrigger();

      const first = await reserveEventFiring({
        triggerDbId: trigger.id as number,
        triggerPublicId: trigger.publicId as string,
        projectId: trigger.projectId as number,
        eventId: 'evt-dup',
        input: {},
        causationChain: [],
      });
      const second = await reserveEventFiring({
        triggerDbId: trigger.id as number,
        triggerPublicId: trigger.publicId as string,
        projectId: trigger.projectId as number,
        eventId: 'evt-dup',
        input: {},
        causationChain: [],
      });

      expect(first).not.toBeNull();
      expect(second).toBeNull();

      const rows = await db.TriggerFiring.findAll({
        where: { triggerId: trigger.id as number },
      });
      expect(rows).toHaveLength(1);
    });

    test('one event reaching two triggers reserves for each', async () => {
      const first = await createEventTrigger();
      const second = await createEventTrigger();

      for (const trigger of [first, second]) {
        const reserved = await reserveEventFiring({
          triggerDbId: trigger.id as number,
          triggerPublicId: trigger.publicId as string,
          projectId: trigger.projectId as number,
          eventId: 'evt-fanout',
          input: {},
          causationChain: [],
        });
        expect(reserved).not.toBeNull();
      }
    });
  });

  describe('redelivery', () => {
    test('an interrupted firing is picked up and run to a result', async () => {
      const trigger = await createEventTrigger();
      const firing = await abandonedFiring({ trigger, eventId: 'evt-sweep-1' });

      expect(await sweepDueEventFirings()).toBe(1);

      const settled = await waitForTerminal(firing.id as number);
      expect(settled.status).toBe('succeeded');
      expect(settled.attempts).toBe(2);
    }, 60_000);

    test('a firing left mid-dispatch is redelivered too', async () => {
      const trigger = await createEventTrigger();
      const firing = await abandonedFiring({
        trigger,
        eventId: 'evt-sweep-running',
        status: 'running',
      });

      expect(await sweepDueEventFirings()).toBe(1);

      const settled = await waitForTerminal(firing.id as number);
      expect(settled.status).toBe('succeeded');
    }, 60_000);

    test('overlapping ticks redeliver one firing once', async () => {
      const trigger = await createEventTrigger();
      const firing = await abandonedFiring({ trigger, eventId: 'evt-sweep-2' });

      const claims = await Promise.all([
        sweepDueEventFirings(),
        sweepDueEventFirings(),
      ]);

      expect(
        claims.reduce((total, count) => {
          return total + count;
        }, 0)
      ).toBe(1);

      const settled = await waitForTerminal(firing.id as number);
      expect(settled.attempts).toBe(2);
    }, 60_000);

    test('a firing whose lease is still live is left alone', async () => {
      const trigger = await createEventTrigger();
      await db.TriggerFiring.create({
        triggerId: trigger.id as number,
        projectId: trigger.projectId as number,
        source: 'event',
        status: 'running',
        input: {},
        result: null,
        error: null,
        idempotencyKey: `evt-live:${trigger.publicId as string}`,
        causationChain: [],
        attempts: 1,
        leaseExpiresAt: new Date(Date.now() + EVENT_FIRING_LEASE_MS),
        startedAt: new Date(),
        completedAt: null,
      });

      expect(await sweepDueEventFirings()).toBe(0);
    });

    test('a firing that reached a result is never redelivered', async () => {
      const trigger = await createEventTrigger();
      await db.TriggerFiring.create({
        triggerId: trigger.id as number,
        projectId: trigger.projectId as number,
        source: 'event',
        status: 'failed',
        input: {},
        result: null,
        error: { code: 'BOOM', message: 'the target said no' },
        idempotencyKey: `evt-terminal:${trigger.publicId as string}`,
        causationChain: [],
        attempts: 1,
        leaseExpiresAt: new Date(Date.now() - EVENT_FIRING_LEASE_MS),
        startedAt: new Date(),
        completedAt: new Date(),
      });

      expect(await sweepDueEventFirings()).toBe(0);
    });

    /**
     * A schedule firing recovers from the trigger's own `next_fire_at`, and a
     * manual or webhook fire had a caller that was told what happened. Sweeping
     * them here would run each of those a second time.
     */
    test('a firing from another source is not this sweep’s to redeliver', async () => {
      const trigger = await createEventTrigger();
      await db.TriggerFiring.create({
        triggerId: trigger.id as number,
        projectId: trigger.projectId as number,
        source: 'schedule',
        status: 'pending',
        input: {},
        result: null,
        error: null,
        idempotencyKey: null,
        causationChain: null,
        attempts: 1,
        leaseExpiresAt: new Date(Date.now() - EVENT_FIRING_LEASE_MS),
        startedAt: null,
        completedAt: null,
      });

      expect(await sweepDueEventFirings()).toBe(0);
    });
  });

  describe('giving up', () => {
    test('a firing out of attempts is closed rather than retried', async () => {
      const trigger = await createEventTrigger();
      const firing = await abandonedFiring({
        trigger,
        eventId: 'evt-exhausted',
        attempts: MAX_EVENT_FIRING_ATTEMPTS,
      });

      expect(await sweepDueEventFirings()).toBe(0);
      expect(await failExhaustedEventFirings()).toBe(1);

      const settled = await db.TriggerFiring.findOne({
        where: { id: firing.id as number },
      });
      expect(settled!.status).toBe('failed');
      expect(settled!.error).toMatchObject({
        code: 'TRIGGER_FIRING_ABANDONED',
      });
      expect(settled!.leaseExpiresAt).toBeNull();
    });

    test('a firing with attempts left is not closed', async () => {
      const trigger = await createEventTrigger();
      await abandonedFiring({
        trigger,
        eventId: 'evt-not-exhausted',
        attempts: MAX_EVENT_FIRING_ATTEMPTS - 1,
      });

      expect(await failExhaustedEventFirings()).toBe(0);
    });
  });
});
