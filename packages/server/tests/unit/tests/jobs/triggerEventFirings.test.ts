import { randomUUID } from 'node:crypto';

import { db } from 'src/db';
import { emitEvent } from 'src/lib/eventBus';
import { asCustomEventName } from 'src/lib/soatEvents';
import {
  EVENT_FIRING_LEASE_MS,
  failExhaustedEventFirings,
  MAX_EVENT_FIRING_ATTEMPTS,
  sweepDueEventFirings,
} from 'src/lib/triggerEventFirings';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

const EVENT_NAME = 'durable.tick';

/**
 * Durable event firings: the firing row exists before the dispatch, so a
 * process that dies mid-dispatch leaves the trigger scheduler's sweeps
 * something to find. The sweeps are the scheduler tick, driven by hand because
 * unit tests never import `server.ts`; outcomes are read back through
 * `GET /api/v1/trigger-firings/:firing_id`.
 *
 * The interruption is written rather than caused: a test cannot kill the
 * process it runs in, and what a dead process leaves behind — a `pending` or
 * `running` row whose lease nobody renewed — is exactly reproducible.
 */

type Firing = {
  id: string;
  status: string;
  attempts: number;
  error: Record<string, unknown> | null;
};

describe('Durable event firings', () => {
  let userToken: string;
  let projectId: string;
  let projectDbId: number;
  let inertOrchestrationId: string;
  let seq = 0;

  const asUser = () => {
    return authenticatedTestClient(userToken);
  };

  const createEventTrigger = async () => {
    seq += 1;
    const res = await asUser()
      .post('/api/v1/triggers')
      .send({
        project_id: projectId,
        name: `durable-${seq}`,
        type: 'event',
        event_pattern: EVENT_NAME,
        target_type: 'orchestration',
        target_id: inertOrchestrationId,
      });
    expect(res.status).toBe(201);
    const row = await db.Trigger.findOne({ where: { publicId: res.body.id } });
    return row!;
  };

  /** A firing whose process went away: claimed, never finished. */
  const strandedFiring = async (args: {
    trigger: InstanceType<typeof db.Trigger>;
    status?: string;
    source?: string;
    attempts?: number;
    causationChain?: string[] | null;
    leaseExpiresAt?: Date;
  }): Promise<string> => {
    const firing = await db.TriggerFiring.create({
      triggerId: args.trigger.id as number,
      projectId: args.trigger.projectId as number,
      source: args.source ?? 'event',
      status: args.status ?? 'pending',
      input: { event: EVENT_NAME },
      result: null,
      error: null,
      idempotencyKey: `${randomUUID()}:${args.trigger.publicId as string}`,
      causationChain:
        args.causationChain === undefined ? [] : args.causationChain,
      attempts: args.attempts ?? 1,
      leaseExpiresAt:
        args.leaseExpiresAt ?? new Date(Date.now() - EVENT_FIRING_LEASE_MS),
      startedAt: null,
      completedAt: null,
    });
    return firing.publicId as string;
  };

  const getFiring = async (firingId: string): Promise<Firing> => {
    const res = await asUser().get(`/api/v1/trigger-firings/${firingId}`);
    expect(res.status).toBe(200);
    return res.body;
  };

  /** The sweep dispatches detached, so poll the firing. */
  const waitForTerminal = async (firingId: string): Promise<Firing> => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const firing = await getFiring(firingId);
      if (firing.status === 'succeeded' || firing.status === 'failed') {
        return firing;
      }
      await new Promise((resolve) => {
        return setTimeout(resolve, 25);
      });
    }
    throw new Error(`firing ${firingId} never settled`);
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'durablefire',
      policyActions: [
        'orchestrations:CreateOrchestration',
        'orchestrations:StartRun',
        'triggers:CreateTrigger',
        'triggers:ListTriggerFirings',
        'triggers:GetTriggerFiring',
      ],
      createNoPermUser: false,
    });
    userToken = setup.userToken;
    projectId = setup.projectId;
    projectDbId = (await db.Project.findOne({
      where: { publicId: projectId },
    }))!.id as number;

    const orchestration = await asUser()
      .post('/api/v1/orchestrations')
      .send({
        project_id: projectId,
        name: 'durable-inert',
        nodes: [{ id: 'noop', type: 'transform', expression: 42 }],
        edges: [],
      });
    expect(orchestration.status).toBe(201);
    inertOrchestrationId = orchestration.body.id;
  }, 60_000);

  describe('an event delivered twice → one firing', () => {
    test('the second delivery of the same event reserves nothing', async () => {
      const trigger = await createEventTrigger();
      const emit = (id: string) => {
        emitEvent({
          id,
          type: asCustomEventName({ name: EVENT_NAME }),
          projectId: projectDbId,
          projectPublicId: projectId,
          resourceType: 'orchestration_run',
          resourceId: `run_durable_${id}`,
          data: {},
          timestamp: new Date().toISOString(),
        });
      };
      const listFirings = async () => {
        const res = await asUser().get(
          `/api/v1/trigger-firings?trigger_id=${trigger.publicId as string}`
        );
        expect(res.status).toBe(200);
        return res.body.data as Array<{ status: string }>;
      };
      const waitForSettled = async (count: number) => {
        for (let attempt = 0; attempt < 400; attempt += 1) {
          const settled = (await listFirings()).filter((firing) => {
            return firing.status === 'succeeded';
          });
          if (settled.length >= count) return;
          await new Promise((resolve) => {
            return setTimeout(resolve, 25);
          });
        }
        throw new Error(`never saw ${count} settled firings`);
      };

      const redelivered = randomUUID();
      emit(redelivered);
      await waitForSettled(1);

      emit(redelivered);
      // A distinct event behind the duplicate: once its firing settles, the
      // duplicate has had its reservation refused.
      emit(randomUUID());
      await waitForSettled(2);

      expect(await listFirings()).toHaveLength(2);
    }, 60_000);
  });

  describe('sweepDueEventFirings → a stranded firing', () => {
    test('a pending firing is picked up and run to a result', async () => {
      const firingId = await strandedFiring({
        trigger: await createEventTrigger(),
      });

      await sweepDueEventFirings();

      const settled = await waitForTerminal(firingId);
      expect(settled.status).toBe('succeeded');
      expect(settled.attempts).toBe(2);
    }, 60_000);

    test('a firing left mid-dispatch is redelivered too', async () => {
      const firingId = await strandedFiring({
        trigger: await createEventTrigger(),
        status: 'running',
      });

      await sweepDueEventFirings();

      expect((await waitForTerminal(firingId)).status).toBe('succeeded');
    }, 60_000);

    test('overlapping ticks redeliver it once', async () => {
      const firingId = await strandedFiring({
        trigger: await createEventTrigger(),
      });

      await Promise.all([sweepDueEventFirings(), sweepDueEventFirings()]);

      // Each claim adds an attempt, so a second dispatch would read 3.
      expect((await waitForTerminal(firingId)).attempts).toBe(2);
    }, 60_000);

    test('a firing with no stored chain runs under an empty one', async () => {
      const firingId = await strandedFiring({
        trigger: await createEventTrigger(),
        causationChain: null,
      });

      await sweepDueEventFirings();

      expect((await waitForTerminal(firingId)).status).toBe('succeeded');
    }, 60_000);

    test('a live lease, a result, or another source is left alone', async () => {
      const trigger = await createEventTrigger();
      const leased = await strandedFiring({
        trigger,
        status: 'running',
        leaseExpiresAt: new Date(Date.now() + EVENT_FIRING_LEASE_MS),
      });
      const finished = await strandedFiring({ trigger, status: 'failed' });
      // A schedule firing recovers from `next_fire_at`; a manual or webhook
      // fire had a caller that was told what happened.
      const scheduled = await strandedFiring({ trigger, source: 'schedule' });

      await sweepDueEventFirings();

      for (const [firingId, status] of [
        [leased, 'running'],
        [finished, 'failed'],
        [scheduled, 'pending'],
      ]) {
        const firing = await getFiring(firingId);
        expect(firing.status).toBe(status);
        expect(firing.attempts).toBe(1);
      }
    });
  });

  describe('failExhaustedEventFirings → a firing out of attempts', () => {
    test('is closed rather than retried', async () => {
      const firingId = await strandedFiring({
        trigger: await createEventTrigger(),
        attempts: MAX_EVENT_FIRING_ATTEMPTS,
      });

      await sweepDueEventFirings();
      expect((await getFiring(firingId)).status).toBe('pending');

      await failExhaustedEventFirings();

      const closed = await getFiring(firingId);
      expect(closed.status).toBe('failed');
      expect(closed.attempts).toBe(MAX_EVENT_FIRING_ATTEMPTS);
      expect(closed.error).toMatchObject({ code: 'TRIGGER_FIRING_ABANDONED' });
    });

    test('a firing with attempts left is not closed', async () => {
      const firingId = await strandedFiring({
        trigger: await createEventTrigger(),
        attempts: MAX_EVENT_FIRING_ATTEMPTS - 1,
        status: 'running',
        // Still leased, so the redelivery sweep of another test leaves it be.
        leaseExpiresAt: new Date(Date.now() + EVENT_FIRING_LEASE_MS),
      });

      await failExhaustedEventFirings({
        now: new Date(Date.now() + 2 * EVENT_FIRING_LEASE_MS),
      });

      expect((await getFiring(firingId)).status).toBe('running');
    });
  });
});
