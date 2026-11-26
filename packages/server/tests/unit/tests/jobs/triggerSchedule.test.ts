import { fireDueTriggers } from 'src/lib/triggerScheduler';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { pollFor } from '../../fixtures/poll';
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
  let userPolicyId: string;
  let orchestrationId: string;
  let seq = 0;

  const asUser = () => {
    return authenticatedTestClient(userToken);
  };

  const createScheduleTrigger = async (
    cron = '0 8 * * *',
    target = { id: '', input: undefined as Record<string, unknown> | undefined }
  ) => {
    seq += 1;
    const res = await asUser()
      .post('/api/v1/triggers')
      .send({
        project_id: projectId,
        name: `sched-${seq}`,
        policy_ids: [userPolicyId],
        type: 'schedule',
        target_type: 'orchestration',
        target_id: target.id || orchestrationId,
        input: target.input,
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
    return res.body.data as Array<{
      status: string;
      source: string;
      input: Record<string, unknown> | null;
      result: { result_id: string } | null;
    }>;
  };

  /** The tick fires detached, so poll for the settled firing. */
  const waitForSettledFiring = (triggerId: string) => {
    return pollFor({
      read: () => {
        return listFirings(triggerId);
      },
      pick: ([firing]) => {
        return firing && ['completed', 'failed'].includes(firing.status)
          ? firing
          : undefined;
      },
    });
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
        'orchestrations:GetRun',
      ],
      createNoPermUser: false,
    });
    userToken = setup.userToken;
    projectId = setup.projectId;
    userPolicyId = setup.policyId;

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
      expect(firing.status).toBe('completed');
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

  describe('a firing time in the run input', () => {
    test('the run reads fired_at, the firing time, over a static fired_at', async () => {
      const reader = await asUser()
        .post('/api/v1/orchestrations')
        .send({
          project_id: projectId,
          name: 'Sched fired_at reader',
          nodes: [
            {
              id: 'cutoff',
              type: 'transform',
              expression: { var: 'input.fired_at' },
              state_mapping: { 'state.cutoff': { var: 'output.result' } },
            },
          ],
          edges: [],
        });
      expect(reader.status).toBe(201);
      const trigger = await createScheduleTrigger('0 8 * * *', {
        id: reader.body.id,
        input: { fired_at: 'static' },
      });
      const before = new Date().toISOString();

      await fireDueTriggers({
        now: new Date(trigger.nextFireAt.getTime() + HOUR_MS),
      });

      const firing = await waitForSettledFiring(trigger.id);
      expect(firing.status).toBe('completed');
      const firedAt = firing.input?.fired_at;
      expect(typeof firedAt).toBe('string');
      expect(new Date(String(firedAt)).toISOString()).toBe(firedAt);
      expect(String(firedAt) >= before).toBe(true);

      const run = await asUser().get(
        `/api/v1/orchestration-runs/${firing.result?.result_id}`
      );
      expect(run.status).toBe(200);
      expect(run.body.state.cutoff).toBe(firedAt);
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
