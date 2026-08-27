import { db } from 'src/db';
import { MAX_EVENT_CAUSATION_DEPTH } from 'src/lib/eventCausation';
import * as quotaEnforcement from 'src/lib/quotaEnforcement';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * Event triggers are driven end-to-end through the **real bus**: `app.ts`
 * subscribes the dispatcher at load, so emitting an event is the entry point,
 * exactly as in production. Nothing here is mocked.
 *
 * Every event these tests put on the bus comes from an orchestration
 * `emit_event` node, which is the only sanctioned producer of a user-authored
 * name — so the cycle under test (`emit → trigger → run → emit`) is the real
 * one, not a synthesized envelope.
 */

const EVENT_NAME = 'evtdispatch.tick';

let adminToken: string;
let userToken: string;
let projectId: string;
let projectInternalId: number;

/** The graph whose only node emits the event these triggers subscribe to. */
let emitterOrchestrationId: string;
/** A graph that emits nothing, so firing it cannot extend a causal chain. */
let inertOrchestrationId: string;

let triggerSeq = 0;

const createOrchestration = async (args: {
  name: string;
  emits?: boolean;
}): Promise<string> => {
  const res = await authenticatedTestClient(userToken)
    .post('/api/v1/orchestrations')
    .send({
      project_id: projectId,
      name: args.name,
      nodes: args.emits
        ? [
            {
              id: 'tick',
              type: 'emit_event',
              event_type: EVENT_NAME,
              input_mapping: { reason: 'cycle' },
            },
          ]
        : [{ id: 'noop', type: 'transform', expression: 42 }],
      edges: [],
    });
  expect(res.status).toBe(201);
  return res.body.id as string;
};

const createEventTrigger = async (args: {
  targetId: string;
  eventPattern?: string;
  policyId?: string;
}): Promise<string> => {
  triggerSeq += 1;
  const res = await authenticatedTestClient(userToken)
    .post('/api/v1/triggers')
    .send({
      project_id: projectId,
      name: `evt-${triggerSeq}`,
      type: 'event',
      event_pattern: args.eventPattern ?? EVENT_NAME,
      target_type: 'orchestration',
      target_id: args.targetId,
      ...(args.policyId ? { policy_id: args.policyId } : {}),
    });
  expect(res.status).toBe(201);
  return res.body.id as string;
};

/** Runs the emitting graph once, which puts one event on the bus. */
const emitOnce = async (): Promise<void> => {
  const res = await authenticatedTestClient(userToken)
    .post('/api/v1/orchestration-runs')
    .send({
      wait: true,
      orchestration_id: emitterOrchestrationId,
      input: {},
    });
  expect(res.status).toBe(201);
  expect(res.body.status).toBe('succeeded');
};

const listFirings = async (triggerPublicId: string) => {
  const trigger = await db.Trigger.findOne({
    where: { publicId: triggerPublicId },
  });
  return db.TriggerFiring.findAll({
    where: { triggerId: trigger?.id as number },
    order: [['createdAt', 'ASC']],
  });
};

/**
 * Dispatch is fire-and-forget off the bus, so a firing may not exist the moment
 * the emitting run returns. Polls the observable side effect — the firing rows —
 * rather than sleeping a fixed interval.
 */
const waitForFirings = async (args: {
  triggerId: string;
  count: number;
  terminal?: boolean;
}): Promise<InstanceType<typeof db.TriggerFiring>[]> => {
  const terminal = args.terminal ?? true;
  for (let i = 0; i < 4000; i += 1) {
    const firings = await listFirings(args.triggerId);
    const settled = terminal
      ? firings.filter((f) => {
          return f.status === 'succeeded' || f.status === 'failed';
        })
      : firings;
    if (settled.length >= args.count) return settled;
  }
  throw new Error(
    `trigger ${args.triggerId} never produced ${args.count} settled firing(s)`
  );
};

const countExceptions = async (kind: string): Promise<number> => {
  return db.ExceptionItem.count({
    where: { projectId: projectInternalId, kind },
  });
};

/**
 * The refused firing is written *before* the exception is filed, so observing
 * the firing does not imply the exception has landed. Polls the count rather
 * than reading it once at a fixed point.
 */
const waitForExceptionCount = async (args: {
  kind: string;
  count: number;
}): Promise<number> => {
  for (let i = 0; i < 4000; i += 1) {
    const found = await countExceptions(args.kind);
    if (found >= args.count) return found;
  }
  throw new Error(
    `never observed ${args.count} '${args.kind}' exception(s) in this project`
  );
};

beforeAll(async () => {
  const setup = await setupProjectWithUsers({
    prefix: 'evtdisp',
    policyActions: [
      'triggers:CreateTrigger',
      'triggers:ListTriggers',
      'triggers:GetTrigger',
      'triggers:UpdateTrigger',
      'orchestrations:CreateOrchestration',
      'orchestrations:GetOrchestration',
      'orchestrations:StartRun',
    ],
    createNoPermUser: false,
  });
  adminToken = setup.adminToken;
  userToken = setup.userToken;
  projectId = setup.projectId;

  const project = await db.Project.findOne({ where: { publicId: projectId } });
  projectInternalId = project?.id as number;

  emitterOrchestrationId = await createOrchestration({
    name: 'Emitter',
    emits: true,
  });
  inertOrchestrationId = await createOrchestration({ name: 'Inert' });
}, 120_000);

describe('event triggers', () => {
  test('an emitted event fires the bound target, with the event as input', async () => {
    const triggerId = await createEventTrigger({
      targetId: inertOrchestrationId,
    });

    await emitOnce();

    const [firing] = await waitForFirings({ triggerId, count: 1 });
    expect(firing.status).toBe('succeeded');
    expect(firing.source).toBe('event');

    // The event payload is the firing input, carried opaquely.
    const input = firing.input as Record<string, unknown>;
    expect(input.event).toBe(EVENT_NAME);
    expect(input.project_id).toBe(projectId);
    expect(input.resource_type).toBe('orchestration_run');
    expect(input.data).toEqual({ reason: 'cycle' });

    const result = firing.result as Record<string, unknown>;
    expect(result.target_type).toBe('orchestration');
    expect(result.status).toBe('succeeded');
  }, 60_000);

  test('a pattern that does not match the event does not fire', async () => {
    const triggerId = await createEventTrigger({
      targetId: inertOrchestrationId,
      eventPattern: 'evtdispatch.other',
    });

    await emitOnce();

    // The matching trigger from the previous test settles on the same event, so
    // by the time it has a new firing this one has had its chance to match.
    expect(await listFirings(triggerId)).toHaveLength(0);
  }, 60_000);

  test('an inactive trigger does not fire', async () => {
    const triggerId = await createEventTrigger({
      targetId: inertOrchestrationId,
    });
    const patchRes = await authenticatedTestClient(userToken)
      .patch(`/api/v1/triggers/${triggerId}`)
      .send({ active: false });
    expect(patchRes.status).toBe(200);

    await emitOnce();

    expect(await listFirings(triggerId)).toHaveLength(0);
  }, 60_000);

  test('a self-triggering cycle terminates and files an exception', async () => {
    const before = await countExceptions('event_trigger_loop');

    // The trigger runs the graph that emits the very event it subscribes to.
    const triggerId = await createEventTrigger({
      targetId: emitterOrchestrationId,
    });

    await emitOnce();

    // Exactly two firings ever exist: the one the external emit caused, and the
    // refusal of the event that firing itself produced. The cycle stops there.
    const firings = await waitForFirings({ triggerId, count: 2 });
    expect(firings).toHaveLength(2);
    expect(firings[0].status).toBe('succeeded');
    expect(firings[1].status).toBe('failed');

    const error = firings[1].error as Record<string, unknown>;
    expect(error.code).toBe('TRIGGER_CAUSATION_LIMIT');
    expect(error.meta).toMatchObject({
      reason: 'repeat',
      causation_chain: [triggerId],
    });

    expect(
      await waitForExceptionCount({
        kind: 'event_trigger_loop',
        count: before + 1,
      })
    ).toBe(before + 1);

    const exception = await db.ExceptionItem.findOne({
      where: { projectId: projectInternalId, kind: 'event_trigger_loop' },
      order: [['createdAt', 'DESC']],
    });
    expect(exception?.severity).toBe('warning');
    expect(exception?.detail).toMatchObject({
      triggerId,
      eventType: EVENT_NAME,
      reason: 'repeat',
    });

    // Still exactly two after the refusal has had time to settle: a refusal
    // must not itself become an event that fires anything.
    expect(await listFirings(triggerId)).toHaveLength(2);
  }, 120_000);
});

describe('policy gating', () => {
  /**
   * A boundary policy for the dispatcher to evaluate. Actions are `*` because a
   * policy action must be `resource:Action`-shaped, while the dispatcher passes
   * the raw event name — so effect is what a policy can meaningfully vary here,
   * exactly as in `webhookDispatcher.test.ts`.
   */
  const createEventPolicy = async (effect: string): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: { statement: [{ effect, action: ['*'], resource: ['*'] }] },
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  test('an attached policy that denies the event blocks the firing', async () => {
    const blockedTriggerId = await createEventTrigger({
      targetId: inertOrchestrationId,
      policyId: await createEventPolicy('Deny'),
    });
    const allowedTriggerId = await createEventTrigger({
      targetId: inertOrchestrationId,
      policyId: await createEventPolicy('Allow'),
    });

    await emitOnce();

    // The allowed trigger settling proves the event reached the dispatcher, so
    // the denied one has had its chance to match.
    const [allowed] = await waitForFirings({
      triggerId: allowedTriggerId,
      count: 1,
    });
    expect(allowed.status).toBe('succeeded');
    expect(await listFirings(blockedTriggerId)).toHaveLength(0);
  }, 60_000);
});

describe('one failing trigger does not stop the others', () => {
  test('a trigger whose input cannot satisfy its target is skipped', async () => {
    // An `input_schema` the event envelope cannot satisfy makes `prepareFiring`
    // throw before any firing record exists — the one dispatch failure that is
    // raised rather than recorded. The other trigger on the same event must
    // still run.
    const strictRes = await authenticatedTestClient(userToken)
      .post('/api/v1/orchestrations')
      .send({
        project_id: projectId,
        name: 'Strict Input',
        nodes: [{ id: 'noop', type: 'transform', expression: 42 }],
        edges: [],
        input_schema: {
          type: 'object',
          required: ['order_id'],
          properties: { order_id: { type: 'string' } },
        },
      });
    expect(strictRes.status).toBe(201);

    const brokenTriggerId = await createEventTrigger({
      targetId: strictRes.body.id as string,
    });
    const healthyTriggerId = await createEventTrigger({
      targetId: inertOrchestrationId,
    });

    await emitOnce();

    const [healthy] = await waitForFirings({
      triggerId: healthyTriggerId,
      count: 1,
    });
    expect(healthy.status).toBe('succeeded');

    // The broken one never got as far as a firing record.
    expect(await listFirings(brokenTriggerId)).toHaveLength(0);
  }, 60_000);
});

describe('causation depth', () => {
  test('a chain of distinct triggers is refused past the depth cap', async () => {
    // Each hop is its own event name and its own trigger, so the repeat guard
    // never fires and the depth cap is the only thing that can stop the chain.
    const hops = MAX_EVENT_CAUSATION_DEPTH + 1;
    const eventName = (i: number) => {
      return `evtdepth.hop${i}`;
    };

    // emitter[i] emits hop(i); trigger[i] listens to hop(i) and runs emitter[i+1].
    const emitters: string[] = [];
    for (let i = 0; i <= hops; i += 1) {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/orchestrations')
        .send({
          project_id: projectId,
          name: `Depth Emitter ${i}`,
          nodes: [
            {
              id: 'tick',
              type: 'emit_event',
              event_type: eventName(i),
              input_mapping: { hop: i },
            },
          ],
          edges: [],
        });
      expect(res.status).toBe(201);
      emitters.push(res.body.id as string);
    }

    const triggerIds: string[] = [];
    for (let i = 0; i < hops; i += 1) {
      triggerIds.push(
        await createEventTrigger({
          targetId: emitters[i + 1],
          eventPattern: eventName(i),
        })
      );
    }

    const before = await countExceptions('event_trigger_loop');

    // Start the chain by running emitter[0] directly.
    const startRes = await authenticatedTestClient(userToken)
      .post('/api/v1/orchestration-runs')
      .send({ wait: true, orchestration_id: emitters[0], input: {} });
    expect(startRes.status).toBe(201);

    // The first MAX_EVENT_CAUSATION_DEPTH hops run; the one past the cap is
    // refused, because its chain already holds that many trigger ids.
    for (let i = 0; i < MAX_EVENT_CAUSATION_DEPTH; i += 1) {
      const [firing] = await waitForFirings({
        triggerId: triggerIds[i],
        count: 1,
      });
      expect(firing.status).toBe('succeeded');
    }

    const [refused] = await waitForFirings({
      triggerId: triggerIds[MAX_EVENT_CAUSATION_DEPTH],
      count: 1,
    });
    expect(refused.status).toBe('failed');
    const error = refused.error as Record<string, unknown>;
    expect(error.code).toBe('TRIGGER_CAUSATION_LIMIT');
    expect(error.meta).toMatchObject({
      reason: 'depth',
      max_depth: MAX_EVENT_CAUSATION_DEPTH,
    });
    expect(
      (error.meta as { causation_chain: string[] }).causation_chain
    ).toHaveLength(MAX_EVENT_CAUSATION_DEPTH);

    await waitForExceptionCount({
      kind: 'event_trigger_loop',
      count: before + 1,
    });
  }, 180_000);
});

describe('quota admission at fire time', () => {
  test('a breached project requests quota rejects the firing before dispatch', async () => {
    // A separate project, so the quota counter cannot be moved by the other
    // tests' firings. JWT-authenticated requests are never counted, so the only
    // thing that increments this counter is an event trigger firing.
    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'evtdisp Quota Project' });
    expect(projectRes.status).toBe(201);
    const quotaProjectId = projectRes.body.id as string;

    const quotaRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/quotas')
      .send({
        project_id: quotaProjectId,
        scope: 'project',
        metric: 'requests',
        // `calendar_month` cannot roll over mid-test the way a minute window can.
        window: 'calendar_month',
        mode: 'enforce',
        limit: 1,
      });
    expect(quotaRes.status).toBe(201);

    const emitterRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/orchestrations')
      .send({
        project_id: quotaProjectId,
        name: 'Quota Emitter',
        nodes: [
          {
            id: 'tick',
            type: 'emit_event',
            event_type: EVENT_NAME,
            input_mapping: {},
          },
        ],
        edges: [],
      });
    expect(emitterRes.status).toBe(201);

    const inertRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/orchestrations')
      .send({
        project_id: quotaProjectId,
        name: 'Quota Inert',
        nodes: [{ id: 'noop', type: 'transform', expression: 42 }],
        edges: [],
      });
    expect(inertRes.status).toBe(201);

    const triggerRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/triggers')
      .send({
        project_id: quotaProjectId,
        name: 'quota-evt',
        type: 'event',
        event_pattern: EVENT_NAME,
        target_type: 'orchestration',
        target_id: inertRes.body.id,
      });
    expect(triggerRes.status).toBe(201);
    const triggerId = triggerRes.body.id as string;

    const emit = async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/orchestration-runs')
        .send({
          wait: true,
          orchestration_id: emitterRes.body.id,
          input: {},
        });
      expect(res.status).toBe(201);
    };

    await emit();
    const first = await waitForFirings({ triggerId, count: 1 });
    expect(first[0].status).toBe('succeeded');

    await emit();
    const both = await waitForFirings({ triggerId, count: 2 });
    expect(both[1].status).toBe('failed');
    const error = both[1].error as Record<string, unknown>;
    expect(error.code).toBe('QUOTA_EXCEEDED');

    // Rejected *before* dispatch: no run was started for the second firing.
    expect(both[1].result).toBeNull();
  }, 120_000);

  test('a counter error fails open and the firing still dispatches', async () => {
    // Sanctioned force-failure stub: no real counter write fails
    // deterministically, and this fail-open branch — a quota is cost control,
    // not authorization — is unreachable any other way.
    const spy = jest
      .spyOn(quotaEnforcement, 'evaluateRequestQuotas')
      .mockRejectedValueOnce(new Error('counter unavailable'));

    try {
      const triggerId = await createEventTrigger({
        targetId: inertOrchestrationId,
      });

      await emitOnce();

      const [firing] = await waitForFirings({ triggerId, count: 1 });
      expect(firing.status).toBe('succeeded');
    } finally {
      spy.mockRestore();
    }
  }, 60_000);
});
