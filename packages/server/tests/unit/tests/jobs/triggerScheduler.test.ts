import { db } from 'src/db';
import { fireDueTriggers } from 'src/lib/triggerScheduler';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

const flush = () => {
  return new Promise<void>((resolve) => {
    return setImmediate(resolve);
  });
};

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

/**
 * The tick's guard against a stored row it cannot schedule: a trigger whose
 * `cron` does not parse, or is missing. Every write path validates the cron and
 * clears `next_fire_at` with it, so no entry point stores either row — but a
 * claim that threw on one would end the sweep before the rest of the batch,
 * every tick, since the row is never advanced and stays first in due order.
 * The rest of the tick is pinned at the entry point in
 * `jobs/triggerSchedule.test.ts`.
 */
describe('fireDueTriggers', () => {
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
