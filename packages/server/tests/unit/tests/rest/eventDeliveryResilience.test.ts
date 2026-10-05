import { db } from 'src/db';
import { droppedEventCount, type EventDropStage } from 'src/lib/eventBus';
import { sweepDueWebhookDeliveries } from 'src/lib/webhookDispatcher';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * The event pipeline under a database failure, driven from the request that
 * emits: every stage below runs after that request has committed and answered,
 * so a failure there cannot fail it — it can only lose the event. What is
 * pinned is that a blip costs a retry and nothing else, and that a failure
 * outliving the retries is counted and printed rather than swallowed.
 *
 * Each `jest.spyOn(db.*)` is the sanctioned force-failure stub for a `.catch()`
 * resilience branch: no real database write fails on demand. A `…Once` stub
 * rejects one call and the retry then runs on the real database; a persistent
 * stub is restored as soon as the drop it causes has been observed.
 */

type Delivery = {
  id: string;
  status: string;
  attempts: number;
  payload: { resource_id?: string; project_id?: string };
};

const until = async (predicate: () => Promise<boolean> | boolean) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => {
      return setTimeout(resolve, 25);
    });
  }
  throw new Error('condition never held');
};

/**
 * The line `recordDroppedEvent` prints for one lost event: what an operator
 * reads. The error stream is already silenced by a spy in
 * `setupTestsAfterEnv.ts`, which `spyOn` hands back rather than replacing.
 */
const printedDrop = (args: { stage: EventDropStage; text: string }) => {
  return jest.spyOn(console, 'error').mock.calls.some(([line]) => {
    return (
      typeof line === 'string' &&
      line.startsWith(`event dropped at ${args.stage}: `) &&
      line.includes(args.text)
    );
  });
};

describe('Event delivery resilience', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let webhookId: string;
  let seq = 0;

  const asUser = () => {
    return authenticatedTestClient(userToken);
  };

  const createFile = async (): Promise<string> => {
    seq += 1;
    const res = await asUser()
      .post('/api/v1/files')
      .send({ project_id: projectId, filename: `resilience-${seq}.txt` });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const deliveriesFor = async (fileId: string): Promise<Delivery[]> => {
    const res = await asUser().get(
      `/api/v1/webhook-deliveries?webhook_id=${webhookId}&limit=100`
    );
    expect(res.status).toBe(200);
    return (res.body.data as Delivery[]).filter((delivery) => {
      return delivery.payload.resource_id === fileId;
    });
  };

  const settledDelivery = async (fileId: string): Promise<Delivery> => {
    let found: Delivery | undefined;
    await until(async () => {
      [found] = await deliveriesFor(fileId);
      return found?.status === 'success';
    });
    return found as Delivery;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'evtresilience',
      policyActions: [
        'files:CreateFile',
        'webhooks:CreateWebhook',
        'webhooks:ListWebhookDeliveries',
        'tools:CreateTool',
        'tools:DeleteTool',
        'orchestrations:CreateOrchestration',
        'orchestrations:StartRun',
        'exceptions:ListExceptions',
      ],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;

    const hook = await asUser()
      .post('/api/v1/webhooks')
      .send({
        project_id: projectId,
        name: 'resilience-hook',
        url: 'https://example.com/resilience',
        events: ['files.created'],
      });
    expect(hook.status).toBe(201);
    webhookId = hook.body.id;
  });

  beforeEach(() => {
    jest.spyOn(global, 'fetch').mockImplementation(() => {
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('POST /api/v1/files → the project public-id lookup', () => {
    test('a transient failure is retried and the event keeps its project', async () => {
      const before = droppedEventCount({ stage: 'project_lookup' });
      // Whichever event in flight takes the rejection has attempts to spare,
      // so nothing may drop.
      jest
        .spyOn(db.Project, 'findByPk')
        .mockRejectedValueOnce(new Error('connection terminated'));

      const fileId = await createFile();
      const delivery = await settledDelivery(fileId);

      // The real public id, not the empty placeholder that would build a
      // malformed SRN for webhook policy evaluation.
      expect(delivery.payload.project_id).toBe(projectId);
      expect(droppedEventCount({ stage: 'project_lookup' })).toBe(before);
    });

    test('a failure outliving the retries is counted and printed', async () => {
      const before = droppedEventCount({ stage: 'project_lookup' });
      const down = jest
        .spyOn(db.Project, 'findByPk')
        .mockRejectedValue(new Error('database is down'));

      const fileId = await createFile();
      await until(() => {
        return printedDrop({
          stage: 'project_lookup',
          text: `files.created (${fileId})`,
        });
      });
      down.mockRestore();

      expect(droppedEventCount({ stage: 'project_lookup' })).toBeGreaterThan(
        before
      );
      expect(await deliveriesFor(fileId)).toHaveLength(0);
    });
  });

  describe('POST /api/v1/files → the webhook subscription lookup', () => {
    test('a transient failure does not lose the delivery', async () => {
      const before = droppedEventCount({ stage: 'webhook_lookup' });
      jest
        .spyOn(db.Webhook, 'findAll')
        .mockRejectedValueOnce(new Error('connection terminated'));

      const fileId = await createFile();
      await settledDelivery(fileId);

      expect(await deliveriesFor(fileId)).toHaveLength(1);
      expect(droppedEventCount({ stage: 'webhook_lookup' })).toBe(before);
    });

    test('a failure outliving the retries is counted and printed', async () => {
      const before = droppedEventCount({ stage: 'webhook_lookup' });
      const down = jest
        .spyOn(db.Webhook, 'findAll')
        .mockRejectedValue(new Error('database is down'));

      const fileId = await createFile();
      await until(() => {
        return printedDrop({
          stage: 'webhook_lookup',
          text: `files.created (${fileId})`,
        });
      });
      down.mockRestore();

      expect(droppedEventCount({ stage: 'webhook_lookup' })).toBeGreaterThan(
        before
      );
      expect(await deliveriesFor(fileId)).toHaveLength(0);
    });
  });

  describe('POST /api/v1/files → the delivery row write', () => {
    test('a transient failure writes the row once, on the retry', async () => {
      jest
        .spyOn(db.WebhookDelivery, 'create')
        .mockRejectedValueOnce(new Error('deadlock detected'));

      const fileId = await createFile();
      const delivery = await settledDelivery(fileId);

      expect(delivery.attempts).toBe(1);
      expect(await deliveriesFor(fileId)).toHaveLength(1);
    });

    test('a failure outliving the retries is counted and printed', async () => {
      const before = droppedEventCount({ stage: 'delivery_write' });
      const down = jest
        .spyOn(db.WebhookDelivery, 'create')
        .mockRejectedValue(new Error('database is down'));

      const fileId = await createFile();
      await until(() => {
        return printedDrop({
          stage: 'delivery_write',
          text: `files.created (${fileId})`,
        });
      });
      down.mockRestore();

      expect(droppedEventCount({ stage: 'delivery_write' })).toBe(before + 1);
      expect(await deliveriesFor(fileId)).toHaveLength(0);
    });
  });

  describe('POST /api/v1/files → the first delivery attempt', () => {
    test('a crashed attempt leaves the row to the sweep and is not a lost event', async () => {
      const before = droppedEventCount({ stage: 'delivery_write' });
      // Bookkeeping failing, not the endpoint: the read that prepares the
      // attempt rejects after the row is written.
      jest
        .spyOn(db.Webhook, 'findByPk')
        .mockRejectedValueOnce(new Error('connection terminated'));

      const fileId = await createFile();
      await until(async () => {
        return (await deliveriesFor(fileId)).length === 1;
      });

      // On disk, so not counted as dropped: a failed attempt and a failed row
      // write are different failures.
      expect(droppedEventCount({ stage: 'delivery_write' })).toBe(before);

      // The row still holds the lease the crashed attempt took; once it lapses
      // the sweep delivers it.
      await sweepDueWebhookDeliveries({
        now: new Date(Date.now() + 2 * 60 * 1000),
      });
      const delivery = await settledDelivery(fileId);
      expect(delivery.attempts).toBe(1);
    });
  });

  describe('POST /api/v1/orchestration-runs → the exception filed for a failed run', () => {
    const runFailingOrchestration = async (): Promise<string> => {
      const tool = await asUser()
        .post('/api/v1/tools')
        .send({
          project_id: projectId,
          name: `resilience-gone-${(seq += 1)}`,
          type: 'http',
          execute: { url: 'https://example.com/gone', method: 'POST' },
        });
      expect(tool.status).toBe(201);
      const orchestration = await asUser()
        .post('/api/v1/orchestrations')
        .send({
          project_id: projectId,
          name: `resilience-failing-${seq}`,
          nodes: [
            {
              id: 'boom',
              type: 'tool',
              tool_id: tool.body.id,
              input_mapping: {},
            },
          ],
          edges: [],
        });
      expect(orchestration.status).toBe(201);
      // Deleted after the graph is written, so the node fails at run time.
      const deleted = await authenticatedTestClient(adminToken).delete(
        `/api/v1/tools/${tool.body.id}`
      );
      expect(deleted.status).toBe(204);

      const run = await asUser().post('/api/v1/orchestration-runs').send({
        wait: true,
        orchestration_id: orchestration.body.id,
        input: {},
      });
      expect(run.status).toBe(201);
      expect(run.body.status).toBe('failed');
      return run.body.id;
    };

    const runFailedException = async (runId: string) => {
      const res = await asUser().get(
        `/api/v1/exceptions?project_id=${projectId}&kind=run_failed`
      );
      expect(res.status).toBe(200);
      return (
        res.body.data as Array<{ orchestration_run_id: string | null }>
      ).find((exception) => {
        return exception.orchestration_run_id === runId;
      });
    };

    test('a transient failure still files the exception', async () => {
      jest
        .spyOn(db.ExceptionItem, 'create')
        .mockRejectedValueOnce(new Error('deadlock detected'));

      const runId = await runFailingOrchestration();

      await until(async () => {
        return (await runFailedException(runId)) !== undefined;
      });
    });

    test('a failure outliving the retries is counted and printed', async () => {
      const before = droppedEventCount({ stage: 'exception_file' });
      const down = jest
        .spyOn(db.ExceptionItem, 'create')
        .mockRejectedValue(new Error('database is down'));

      const runId = await runFailingOrchestration();
      await until(() => {
        return printedDrop({
          stage: 'exception_file',
          text: `orchestration_runs.failed (${runId})`,
        });
      });
      down.mockRestore();

      expect(droppedEventCount({ stage: 'exception_file' })).toBe(before + 1);
      expect(await runFailedException(runId)).toBeUndefined();
    });
  });
});
