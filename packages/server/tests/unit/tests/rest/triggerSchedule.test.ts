import { fireDueTriggers } from 'src/lib/triggerScheduler';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Schedule triggers fired by the scheduler tick, driven by hand with an
 * injected clock because unit tests never import `server.ts`. Every trigger
 * is created through the API, so `next_fire_at` is what the API computed; the
 * tick is moved past it instead of the row being moved before it. Outcomes
 * are read back through `GET /api/v1/triggers/:trigger_id` and
 * `GET /api/v1/trigger-firings`.
 */
describe('Schedule trigger tick', () => {
  let userToken: string;
  let projectId: string;
  let orchestrationId: string;
  let seq = 0;

  const asUser = () => {
    return authenticatedTestClient(userToken);
  };

  const createScheduleTrigger = async (cron = '0 8 * * *') => {
    seq += 1;
    const res = await asUser()
      .post('/api/v1/triggers')
      .send({
        project_id: projectId,
        name: `sched-${seq}`,
        type: 'schedule',
        target_type: 'orchestration',
        target_id: orchestrationId,
        cron,
      });
    expect(res.status).toBe(201);
    return {
      id: res.body.id as string,
      nextFireAt: new Date(res.body.next_fire_at),
    };
  };

  const nextFireAt = async (triggerId: string): Promise<Date> => {
    const res = await asUser().get(`/api/v1/triggers/${triggerId}`);
    expect(res.status).toBe(200);
    return new Date(res.body.next_fire_at);
  };

  const listFirings = async (triggerId: string) => {
    const res = await asUser().get(
      `/api/v1/trigger-firings?trigger_id=${triggerId}`
    );
    expect(res.status).toBe(200);
    return res.body.data as Array<{ status: string; source: string }>;
  };

  /** The tick fires detached, so poll for the settled firing. */
  const waitForSettledFiring = async (triggerId: string) => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const [firing] = await listFirings(triggerId);
      if (firing && ['succeeded', 'failed'].includes(firing.status)) {
        return firing;
      }
      await new Promise((resolve) => {
        return setTimeout(resolve, 25);
      });
    }
    throw new Error(`trigger ${triggerId} never fired`);
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'trgsched',
      policyActions: [
        'triggers:CreateTrigger',
        'triggers:GetTrigger',
        'triggers:UpdateTrigger',
        'triggers:ListTriggerFirings',
        'orchestrations:CreateOrchestration',
        'orchestrations:StartRun',
      ],
      createNoPermUser: false,
    });
    userToken = setup.userToken;
    projectId = setup.projectId;

    const orchestration = await asUser()
      .post('/api/v1/orchestrations')
      .send({
        project_id: projectId,
        name: 'Sched Trigger Orchestration',
        nodes: [{ id: 'start', type: 'transform', expression: 42 }],
        edges: [],
      });
    expect(orchestration.status).toBe(201);
    orchestrationId = orchestration.body.id;
  });

  describe('a due schedule trigger', () => {
    test('is claimed, advanced past the tick, and fired once', async () => {
      const trigger = await createScheduleTrigger();
      const now = new Date(trigger.nextFireAt.getTime() + HOUR_MS);

      expect(await fireDueTriggers({ now })).toBeGreaterThanOrEqual(1);

      expect((await nextFireAt(trigger.id)).getTime()).toBeGreaterThan(
        now.getTime()
      );
      const firing = await waitForSettledFiring(trigger.id);
      expect(firing.source).toBe('schedule');
      expect(firing.status).toBe('succeeded');
      expect(await listFirings(trigger.id)).toHaveLength(1);
    });

    test('coalesces missed occurrences into one catch-up firing', async () => {
      const trigger = await createScheduleTrigger('*/5 * * * *');
      // Dozens of */5 slots were missed while nothing ticked.
      const now = new Date(trigger.nextFireAt.getTime() + 3 * HOUR_MS);

      await fireDueTriggers({ now });

      const advanced = await nextFireAt(trigger.id);
      expect(advanced.getTime()).toBeGreaterThan(now.getTime());
      expect(advanced.getTime()).toBeLessThanOrEqual(
        now.getTime() + 5 * 60 * 1000
      );
      await waitForSettledFiring(trigger.id);
      expect(await listFirings(trigger.id)).toHaveLength(1);
    });

    test('fires once across overlapping ticks', async () => {
      const trigger = await createScheduleTrigger();
      const now = new Date(trigger.nextFireAt.getTime() + HOUR_MS);

      await Promise.all([fireDueTriggers({ now }), fireDueTriggers({ now })]);

      await waitForSettledFiring(trigger.id);
      expect(await listFirings(trigger.id)).toHaveLength(1);
    });
  });

  describe('a schedule trigger that is not due', () => {
    test('is not fired before its next_fire_at', async () => {
      const trigger = await createScheduleTrigger();

      await fireDueTriggers({
        now: new Date(trigger.nextFireAt.getTime() - 1),
      });

      expect(await listFirings(trigger.id)).toHaveLength(0);
      expect((await nextFireAt(trigger.id)).getTime()).toBe(
        trigger.nextFireAt.getTime()
      );
    });

    test('is not fired while inactive', async () => {
      const trigger = await createScheduleTrigger();
      const patched = await asUser()
        .patch(`/api/v1/triggers/${trigger.id}`)
        .send({ active: false });
      expect(patched.status).toBe(200);

      await fireDueTriggers({
        now: new Date(trigger.nextFireAt.getTime() + HOUR_MS),
      });

      expect(await listFirings(trigger.id)).toHaveLength(0);
    });
  });
});
