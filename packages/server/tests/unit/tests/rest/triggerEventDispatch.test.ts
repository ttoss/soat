import { MAX_EVENT_CAUSATION_DEPTH } from 'src/lib/eventCausation';
import * as quotaEnforcement from 'src/lib/quotaEnforcement';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * Event triggers driven through the real bus: an orchestration `emit_event`
 * node is the producer, so the cycle under test (`emit → trigger → run →
 * emit`) is the production one. Firings and exceptions are read back through
 * `GET /api/v1/trigger-firings` and `GET /api/v1/exceptions`.
 */

const EVENT_NAME = 'evtdispatch.tick';

type Firing = {
  id: string;
  status: string;
  source: string;
  input: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  idempotency_key: string | null;
  attempts: number;
};

describe('Event trigger dispatch', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  /** Emits nothing, so firing it cannot extend a causal chain. */
  let inertOrchestrationId: string;
  let seq = 0;

  const asUser = () => {
    return authenticatedTestClient(userToken);
  };

  const createOrchestration = async (args: {
    name: string;
    emits?: string;
    project?: string;
    token?: string;
  }): Promise<string> => {
    const res = await authenticatedTestClient(args.token ?? userToken)
      .post('/api/v1/orchestrations')
      .send({
        project_id: args.project ?? projectId,
        name: args.name,
        nodes: args.emits
          ? [
              {
                id: 'tick',
                type: 'emit_event',
                event_type: args.emits,
                input_mapping: { reason: 'cycle' },
              },
            ]
          : [{ id: 'noop', type: 'transform', expression: 42 }],
        edges: [],
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const createEventTrigger = async (args: {
    targetId: string;
    eventPattern: string;
    policyId?: string;
  }): Promise<string> => {
    seq += 1;
    const res = await asUser()
      .post('/api/v1/triggers')
      .send({
        project_id: projectId,
        name: `evt-${seq}`,
        type: 'event',
        event_pattern: args.eventPattern,
        target_type: 'orchestration',
        target_id: args.targetId,
        ...(args.policyId ? { policy_id: args.policyId } : {}),
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const run = async (args: { orchestrationId: string; token?: string }) => {
    const res = await authenticatedTestClient(args.token ?? userToken)
      .post('/api/v1/orchestration-runs')
      .send({ wait: true, orchestration_id: args.orchestrationId, input: {} });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('succeeded');
  };

  /**
   * A graph emitting an event name of its own, so the triggers one test binds
   * never fire for another test's emit.
   */
  const createEmitter = async () => {
    seq += 1;
    const eventName = `${EVENT_NAME}${seq}`;
    const orchestrationId = await createOrchestration({
      name: `Emitter ${seq}`,
      emits: eventName,
    });
    return {
      eventName,
      orchestrationId,
      /** Runs the graph once, which puts one event on the bus. */
      emit: () => {
        return run({ orchestrationId });
      },
    };
  };

  const listFirings = async (args: {
    triggerId: string;
    token?: string;
  }): Promise<Firing[]> => {
    const res = await authenticatedTestClient(args.token ?? userToken).get(
      `/api/v1/trigger-firings?trigger_id=${args.triggerId}&limit=100`
    );
    expect(res.status).toBe(200);
    // Newest first on the wire; oldest first reads as the causal order.
    return [...(res.body.data as Firing[])].reverse();
  };

  /** Dispatch is fire-and-forget off the bus, so poll the firings. */
  const waitForFirings = async (args: {
    triggerId: string;
    count: number;
    token?: string;
  }): Promise<Firing[]> => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const settled = (await listFirings(args)).filter((firing) => {
        return firing.status === 'succeeded' || firing.status === 'failed';
      });
      if (settled.length >= args.count) return settled;
      await new Promise((resolve) => {
        return setTimeout(resolve, 25);
      });
    }
    throw new Error(`trigger ${args.triggerId} never settled ${args.count}`);
  };

  /**
   * The refused firing is written before its exception is filed, so the
   * exception is polled rather than read once.
   */
  const waitForLoopException = async (args: {
    triggerId: string;
    reason: string;
  }) => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const res = await asUser().get(
        `/api/v1/exceptions?project_id=${projectId}&kind=event_trigger_loop&limit=100`
      );
      expect(res.status).toBe(200);
      const match = (
        res.body.data as Array<{
          severity: string;
          detail: Record<string, unknown>;
        }>
      ).find((exception) => {
        return (
          exception.detail.trigger_id === args.triggerId &&
          exception.detail.reason === args.reason
        );
      });
      if (match) return match;
      await new Promise((resolve) => {
        return setTimeout(resolve, 25);
      });
    }
    throw new Error(`no ${args.reason} exception for ${args.triggerId}`);
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'evtdispatch',
      policyActions: [
        'triggers:CreateTrigger',
        'triggers:UpdateTrigger',
        'triggers:ListTriggerFirings',
        'orchestrations:CreateOrchestration',
        'orchestrations:StartRun',
        'exceptions:ListExceptions',
      ],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;

    inertOrchestrationId = await createOrchestration({ name: 'Inert' });
  }, 120_000);

  describe('an emitted event → a matching trigger', () => {
    test('fires the bound target with the event as input, durably keyed', async () => {
      const emitter = await createEmitter();
      const triggerId = await createEventTrigger({
        targetId: inertOrchestrationId,
        eventPattern: emitter.eventName,
      });

      await emitter.emit();

      const [firing] = await waitForFirings({ triggerId, count: 1 });
      expect(firing.status).toBe('succeeded');
      expect(firing.source).toBe('event');
      expect(firing.attempts).toBe(1);
      // `<event id>:<trigger id>`: what a redelivery of the same event dedupes
      // against.
      expect(firing.idempotency_key).toMatch(
        new RegExp(`^[0-9a-f-]+:${triggerId}$`)
      );

      expect(firing.input).toMatchObject({
        event: emitter.eventName,
        project_id: projectId,
        resource_type: 'orchestration_run',
        data: { reason: 'cycle' },
      });
      expect(firing.result).toMatchObject({
        target_type: 'orchestration',
        status: 'succeeded',
      });
    }, 60_000);

    test('a pattern that does not match, or an inactive trigger, does not fire', async () => {
      const emitter = await createEmitter();
      const mismatched = await createEventTrigger({
        targetId: inertOrchestrationId,
        eventPattern: `${emitter.eventName}.other`,
      });
      const inactive = await createEventTrigger({
        targetId: inertOrchestrationId,
        eventPattern: emitter.eventName,
      });
      const patched = await asUser()
        .patch(`/api/v1/triggers/${inactive}`)
        .send({ active: false });
      expect(patched.status).toBe(200);
      const witness = await createEventTrigger({
        targetId: inertOrchestrationId,
        eventPattern: emitter.eventName,
      });

      await emitter.emit();

      // The witness settling proves the event reached the dispatcher, which
      // walks every trigger before it dispatches any.
      await waitForFirings({ triggerId: witness, count: 1 });
      expect(await listFirings({ triggerId: mismatched })).toHaveLength(0);
      expect(await listFirings({ triggerId: inactive })).toHaveLength(0);
    }, 60_000);

    test('an attached policy that denies the event blocks the firing', async () => {
      const createPolicy = async (effect: string): Promise<string> => {
        const res = await authenticatedTestClient(adminToken)
          .post('/api/v1/policies')
          .send({
            document: {
              statement: [{ effect, action: ['*'], resource: ['*'] }],
            },
          });
        expect(res.status).toBe(201);
        return res.body.id;
      };
      const emitter = await createEmitter();
      const blocked = await createEventTrigger({
        targetId: inertOrchestrationId,
        eventPattern: emitter.eventName,
        policyId: await createPolicy('Deny'),
      });
      const allowed = await createEventTrigger({
        targetId: inertOrchestrationId,
        eventPattern: emitter.eventName,
        policyId: await createPolicy('Allow'),
      });

      await emitter.emit();

      const [firing] = await waitForFirings({ triggerId: allowed, count: 1 });
      expect(firing.status).toBe('succeeded');
      expect(await listFirings({ triggerId: blocked })).toHaveLength(0);
    }, 60_000);

    test('a trigger whose input cannot satisfy its target is skipped, the others still run', async () => {
      // An `input_schema` the event envelope cannot satisfy fails before any
      // firing row is written.
      const strict = await asUser()
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
      expect(strict.status).toBe(201);
      const emitter = await createEmitter();
      const broken = await createEventTrigger({
        targetId: strict.body.id,
        eventPattern: emitter.eventName,
      });
      const healthy = await createEventTrigger({
        targetId: inertOrchestrationId,
        eventPattern: emitter.eventName,
      });

      await emitter.emit();

      const [firing] = await waitForFirings({ triggerId: healthy, count: 1 });
      expect(firing.status).toBe('succeeded');
      expect(await listFirings({ triggerId: broken })).toHaveLength(0);
    }, 60_000);
  });

  describe('a causal chain → the loop guards', () => {
    test('a self-triggering cycle stops at its first recurrence and files an exception', async () => {
      // The trigger runs the graph that emits the very event it subscribes to.
      const emitter = await createEmitter();
      const triggerId = await createEventTrigger({
        targetId: emitter.orchestrationId,
        eventPattern: emitter.eventName,
      });

      await emitter.emit();

      const firings = await waitForFirings({ triggerId, count: 2 });
      expect(
        firings.map((firing) => {
          return firing.status;
        })
      ).toEqual(['succeeded', 'failed']);
      expect(firings[1].error).toMatchObject({
        code: 'TRIGGER_CAUSATION_LIMIT',
        meta: { reason: 'repeat', causation_chain: [triggerId] },
      });

      const exception = await waitForLoopException({
        triggerId,
        reason: 'repeat',
      });
      expect(exception.severity).toBe('warning');
      expect(exception.detail).toMatchObject({
        event_type: emitter.eventName,
      });

      // A refusal is not itself an event that fires anything.
      expect(await listFirings({ triggerId })).toHaveLength(2);
    }, 120_000);

    test('a chain of distinct triggers is refused past the depth cap', async () => {
      // A new event name per hop, so only the depth cap can stop the chain.
      const hops = MAX_EVENT_CAUSATION_DEPTH + 1;
      const eventName = (i: number) => {
        return `evtdepth.hop${i}`;
      };
      const emitters: string[] = [];
      for (let i = 0; i <= hops; i += 1) {
        emitters.push(
          await createOrchestration({
            name: `Depth Emitter ${i}`,
            emits: eventName(i),
          })
        );
      }
      // trigger[i] listens to hop(i) and runs emitter[i + 1].
      const triggerIds: string[] = [];
      for (let i = 0; i < hops; i += 1) {
        triggerIds.push(
          await createEventTrigger({
            targetId: emitters[i + 1],
            eventPattern: eventName(i),
          })
        );
      }

      await run({ orchestrationId: emitters[0] });

      for (let i = 0; i < MAX_EVENT_CAUSATION_DEPTH; i += 1) {
        const [firing] = await waitForFirings({
          triggerId: triggerIds[i],
          count: 1,
        });
        expect(firing.status).toBe('succeeded');
      }

      const refusedId = triggerIds[MAX_EVENT_CAUSATION_DEPTH];
      const [refused] = await waitForFirings({
        triggerId: refusedId,
        count: 1,
      });
      expect(refused.status).toBe('failed');
      expect(refused.error).toMatchObject({
        code: 'TRIGGER_CAUSATION_LIMIT',
        meta: { reason: 'depth', max_depth: MAX_EVENT_CAUSATION_DEPTH },
      });
      const meta = (refused.error as { meta: { causation_chain: string[] } })
        .meta;
      expect(meta.causation_chain).toHaveLength(MAX_EVENT_CAUSATION_DEPTH);

      await waitForLoopException({ triggerId: refusedId, reason: 'depth' });
    }, 180_000);
  });

  describe('an emitted event → quota admission at fire time', () => {
    test('a breached requests quota rejects the firing before dispatch', async () => {
      // Its own project, so no other test's firing moves the counter, and
      // JWT requests are never counted: only firings increment it.
      const project = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'evtdispatch Quota Project' });
      expect(project.status).toBe(201);
      const quotaProjectId = project.body.id;
      const quota = await authenticatedTestClient(adminToken)
        .post('/api/v1/quotas')
        .send({
          project_id: quotaProjectId,
          scope: 'project',
          metric: 'requests',
          // `calendar_month` cannot roll over mid-test.
          window: 'calendar_month',
          mode: 'enforce',
          limit: 1,
        });
      expect(quota.status).toBe(201);

      const emitter = await createOrchestration({
        name: 'Quota Emitter',
        emits: EVENT_NAME,
        project: quotaProjectId,
        token: adminToken,
      });
      const inert = await createOrchestration({
        name: 'Quota Inert',
        project: quotaProjectId,
        token: adminToken,
      });
      const trigger = await authenticatedTestClient(adminToken)
        .post('/api/v1/triggers')
        .send({
          project_id: quotaProjectId,
          name: 'quota-evt',
          type: 'event',
          event_pattern: EVENT_NAME,
          target_type: 'orchestration',
          target_id: inert,
        });
      expect(trigger.status).toBe(201);
      const triggerId = trigger.body.id;

      await run({ orchestrationId: emitter, token: adminToken });
      const [first] = await waitForFirings({
        triggerId,
        count: 1,
        token: adminToken,
      });
      expect(first.status).toBe('succeeded');

      await run({ orchestrationId: emitter, token: adminToken });
      const both = await waitForFirings({
        triggerId,
        count: 2,
        token: adminToken,
      });
      expect(both[1].status).toBe('failed');
      expect(both[1].error).toMatchObject({ code: 'QUOTA_EXCEEDED' });
      // Refused before dispatch: no run was started.
      expect(both[1].result).toBeNull();
    }, 120_000);

    test('a counter error fails open and the firing still dispatches', async () => {
      // Sanctioned force-failure stub for the fail-open `.catch()`: a quota is
      // cost control, not authorization, and no real counter read fails on
      // demand.
      const spy = jest
        .spyOn(quotaEnforcement, 'evaluateRequestQuotas')
        .mockRejectedValueOnce(new Error('counter unavailable'));
      try {
        const emitter = await createEmitter();
        const triggerId = await createEventTrigger({
          targetId: inertOrchestrationId,
          eventPattern: emitter.eventName,
        });

        await emitter.emit();

        const [firing] = await waitForFirings({ triggerId, count: 1 });
        expect(firing.status).toBe('succeeded');
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    }, 60_000);
  });
});
