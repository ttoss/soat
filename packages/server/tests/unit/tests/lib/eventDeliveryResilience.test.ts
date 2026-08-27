import { db } from 'src/db';
import {
  droppedEventCount,
  emitEvent,
  emitResourceEvent,
  eventBus,
  onEvent,
  type SoatEvent,
} from 'src/lib/eventBus';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * The entry to the delivery pipeline, under a transient database failure.
 *
 * Direct lib tests by the "no entry point exists" rule (`.claude/rules/tests.md`):
 * every branch here lives on the far side of a fire-and-forget emit that happens
 * *after* the domain write has committed and its response has been written, so
 * no REST call can observe it. What is asserted is that a blip does not silently
 * discard an event, and that a drop the pipeline genuinely cannot recover from is
 * counted rather than swallowed.
 *
 * These use the sanctioned force-failure stub (`.claude/rules/tests.md`,
 * exception 2): a resilience branch that only exists for a rejecting write can
 * only be driven by making that write reject, and no real database write fails
 * deterministically. Each stub rejects **once** — the recovery under test is
 * precisely that the second call is made at all — and the row it then writes is
 * a real row in the real database.
 */

const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  { attempts = 100, intervalMs = 25 } = {}
): Promise<void> => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => {
      return setTimeout(resolve, intervalMs);
    });
  }
  throw new Error('waitFor: condition not met in time');
};

describe('event delivery resilience', () => {
  let adminToken: string;
  let projectId: string;
  let projectInternalId: number;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'eventresilienceadmin', password: 'supersecret' });

    adminToken = await loginAs('eventresilienceadmin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Event Resilience Test Project' });

    projectId = projectRes.body.id;

    const row = await db.Project.findOne({ where: { publicId: projectId } });
    projectInternalId = row!.id as number;
  });

  beforeEach(() => {
    // Every delivery this suite writes is attempted immediately; keep those
    // attempts off the network. `restoreAllMocks` in `afterEach` unwires it.
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 })
      );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const createWebhook = async (args: { name: string; url: string }) => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/webhooks')
      .send({
        project_id: projectId,
        name: args.name,
        url: args.url,
        events: ['files.created'],
      });
    return db.Webhook.findOne({ where: { publicId: res.body.id } });
  };

  const emitFileCreated = (resourceId: string) => {
    emitEvent({
      type: 'files.created',
      projectId: projectInternalId,
      projectPublicId: projectId,
      resourceType: 'file',
      resourceId,
      data: { filename: `${resourceId}.txt` },
      timestamp: new Date().toISOString(),
    });
  };

  describe('the webhook subscription lookup', () => {
    test('a transient failure does not lose the event', async () => {
      const webhook = await createWebhook({
        name: 'Lookup blip',
        url: 'https://example.com/lookup-blip',
      });

      // One rejection, then the real query runs: proves the lookup is retried
      // rather than abandoned on the first error.
      jest
        .spyOn(db.Webhook, 'findAll')
        .mockRejectedValueOnce(new Error('connection terminated'));

      emitFileCreated('fil_lookup_blip');

      await waitFor(async () => {
        const count = await db.WebhookDelivery.count({
          where: { webhookId: webhook!.id },
        });
        return count === 1;
      });

      const [delivery] = await db.WebhookDelivery.findAll({
        where: { webhookId: webhook!.id },
      });
      expect(delivery.eventType).toBe('files.created');
    });

    test('an unrecoverable failure is counted, not swallowed', async () => {
      jest
        .spyOn(db.Webhook, 'findAll')
        .mockRejectedValue(new Error('database is down'));

      const before = droppedEventCount({ stage: 'webhook_lookup' });

      emitFileCreated('fil_lookup_down');

      await waitFor(() => {
        return droppedEventCount({ stage: 'webhook_lookup' }) === before + 1;
      });

      expect(droppedEventCount({ stage: 'webhook_lookup' })).toBe(before + 1);
    });
  });

  describe('the delivery row write', () => {
    test('a transient failure does not lose the event', async () => {
      const webhook = await createWebhook({
        name: 'Write blip',
        url: 'https://example.com/write-blip',
      });

      jest
        .spyOn(db.WebhookDelivery, 'create')
        .mockRejectedValueOnce(new Error('deadlock detected'));

      emitFileCreated('fil_write_blip');

      await waitFor(async () => {
        const count = await db.WebhookDelivery.count({
          where: { webhookId: webhook!.id },
        });
        return count === 1;
      });

      // The row the first `create` failed to write exists, and the sweep-free
      // happy path ran to completion on it — the blip cost nothing but a retry.
      const [delivery] = await db.WebhookDelivery.findAll({
        where: { webhookId: webhook!.id },
      });
      expect(delivery.eventType).toBe('files.created');
      expect(delivery.status).toBe('success');
    });

    test('an unrecoverable failure is counted, not swallowed', async () => {
      await createWebhook({
        name: 'Write down',
        url: 'https://example.com/write-down',
      });

      jest
        .spyOn(db.WebhookDelivery, 'create')
        .mockRejectedValue(new Error('database is down'));

      const before = droppedEventCount({ stage: 'delivery_write' });

      emitFileCreated('fil_write_down');

      await waitFor(() => {
        return droppedEventCount({ stage: 'delivery_write' }) > before;
      });

      expect(droppedEventCount({ stage: 'delivery_write' })).toBeGreaterThan(
        before
      );
    });
  });

  describe('the first delivery attempt', () => {
    test('a crashed attempt leaves the row for the sweep, and is not a lost event', async () => {
      const webhook = await createWebhook({
        name: 'Attempt crash',
        url: 'https://example.com/attempt-crash',
      });

      // A failing request is handled by recording the attempt; what is not is
      // the bookkeeping itself failing. A rejecting `prepareAttempt` read is the
      // only way into that branch.
      jest
        .spyOn(db.Webhook, 'findByPk')
        .mockRejectedValueOnce(new Error('connection terminated'));

      const before = droppedEventCount({ stage: 'delivery_write' });

      emitFileCreated('fil_attempt_crash');

      await waitFor(async () => {
        const count = await db.WebhookDelivery.count({
          where: { webhookId: webhook!.id },
        });
        return count === 1;
      });

      const [delivery] = await db.WebhookDelivery.findAll({
        where: { webhookId: webhook!.id },
      });

      // The row survived the crash, so the delivery is owned by the database
      // and the sweep can retry it — the whole point of separating the row
      // write from the first attempt (#1130). Its status is deliberately not
      // asserted: the sweep may already have reclaimed and delivered it.
      expect(delivery.eventType).toBe('files.created');

      // And it is not counted as dropped: the event is on disk, not lost. A
      // failed attempt and a failed row write are different failures, which is
      // exactly the distinction the two separate `.catch()`es exist to draw.
      expect(droppedEventCount({ stage: 'delivery_write' })).toBe(before);
    });
  });

  describe('the project public-id lookup', () => {
    const withSubscriber = async (
      run: (seen: SoatEvent[]) => Promise<void>
    ): Promise<void> => {
      const seen: SoatEvent[] = [];
      // Unfiltered so the handler is registered unwrapped and can be removed
      // by reference: `eventBus.removeAllListeners` would also tear down the
      // dispatcher and activity listeners that `app.ts` wired at startup.
      const handler = (event: SoatEvent) => {
        seen.push(event);
      };
      onEvent({ handler });
      try {
        await run(seen);
      } finally {
        eventBus.off('soat:event', handler);
      }
    };

    test('a transient failure does not lose the event', async () => {
      await withSubscriber(async (seen) => {
        jest
          .spyOn(db.Project, 'findByPk')
          .mockRejectedValueOnce(new Error('connection terminated'));

        emitResourceEvent({
          type: 'files.created',
          projectId: projectInternalId,
          resourceType: 'file',
          resourceId: 'fil_project_blip',
          data: { filename: 'project-blip.txt' },
        });

        await waitFor(() => {
          return seen.some((event) => {
            return event.resourceId === 'fil_project_blip';
          });
        });

        const event = seen.find((candidate) => {
          return candidate.resourceId === 'fil_project_blip';
        });
        // Recovered with the real public id, not an empty placeholder that
        // would build a malformed SRN for webhook policy evaluation.
        expect(event!.projectPublicId).toBe(projectId);
      });
    });

    test('an unrecoverable failure is counted, not swallowed', async () => {
      await withSubscriber(async (seen) => {
        jest
          .spyOn(db.Project, 'findByPk')
          .mockRejectedValue(new Error('database is down'));

        const before = droppedEventCount({ stage: 'project_lookup' });

        emitResourceEvent({
          type: 'files.created',
          projectId: projectInternalId,
          resourceType: 'file',
          resourceId: 'fil_project_down',
          data: { filename: 'project-down.txt' },
        });

        await waitFor(() => {
          return droppedEventCount({ stage: 'project_lookup' }) === before + 1;
        });

        expect(
          seen.some((event) => {
            return event.resourceId === 'fil_project_down';
          })
        ).toBe(false);
      });
    });
  });

  describe('the activity entry write', () => {
    test('a transient failure does not lose the entry', async () => {
      jest
        .spyOn(db.ActivityEntry, 'create')
        .mockRejectedValueOnce(new Error('deadlock detected'));

      emitEvent({
        type: 'exceptions.created',
        projectId: projectInternalId,
        projectPublicId: projectId,
        resourceType: 'exception',
        resourceId: 'exc_activity_blip',
        data: {
          exception: {
            id: 'exc_activity_blip',
            kind: 'run_failed',
            severity: 'critical',
          },
        },
        timestamp: new Date().toISOString(),
      });

      await waitFor(async () => {
        const count = await db.ActivityEntry.count({
          where: { refId: 'exc_activity_blip' },
        });
        return count === 1;
      });

      const entry = await db.ActivityEntry.findOne({
        where: { refId: 'exc_activity_blip' },
      });
      expect(entry!.kind).toBe('exception_created');
    });

    test('an unrecoverable failure is counted, not swallowed', async () => {
      jest
        .spyOn(db.ActivityEntry, 'create')
        .mockRejectedValue(new Error('database is down'));

      const before = droppedEventCount({ stage: 'activity_write' });

      emitEvent({
        type: 'exceptions.created',
        projectId: projectInternalId,
        projectPublicId: projectId,
        resourceType: 'exception',
        resourceId: 'exc_activity_down',
        data: {
          exception: {
            id: 'exc_activity_down',
            kind: 'run_failed',
            severity: 'critical',
          },
        },
        timestamp: new Date().toISOString(),
      });

      await waitFor(() => {
        return droppedEventCount({ stage: 'activity_write' }) === before + 1;
      });

      expect(droppedEventCount({ stage: 'activity_write' })).toBe(before + 1);
    });
  });

  describe('the exception file write', () => {
    const emitRunFailed = (resourceId: string) => {
      emitEvent({
        type: 'orchestration_runs.failed',
        projectId: projectInternalId,
        projectPublicId: projectId,
        resourceType: 'orchestration_run',
        resourceId,
        data: {},
        timestamp: new Date().toISOString(),
      });
    };

    test('a transient failure does not lose the exception', async () => {
      jest
        .spyOn(db.ExceptionItem, 'create')
        .mockRejectedValueOnce(new Error('deadlock detected'));

      emitRunFailed('run_exception_blip');

      await waitFor(async () => {
        const count = await db.ExceptionItem.count({
          where: { orchestrationRunId: 'run_exception_blip' },
        });
        return count === 1;
      });

      const item = await db.ExceptionItem.findOne({
        where: { orchestrationRunId: 'run_exception_blip' },
      });
      expect(item!.kind).toBe('run_failed');
    });

    test('an unrecoverable failure is counted, not swallowed', async () => {
      jest
        .spyOn(db.ExceptionItem, 'create')
        .mockRejectedValue(new Error('database is down'));

      const before = droppedEventCount({ stage: 'exception_file' });

      emitRunFailed('run_exception_down');

      await waitFor(() => {
        return droppedEventCount({ stage: 'exception_file' }) === before + 1;
      });

      expect(droppedEventCount({ stage: 'exception_file' })).toBe(before + 1);
    });
  });
});
