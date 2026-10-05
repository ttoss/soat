import { db } from 'src/db';
import { DomainError } from 'src/errors';
import {
  driveQueuedRun,
  redriveRun,
  resumeOrchestrationRunExecution,
  wakeRun,
} from 'src/lib/orchestrationEngine';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A driver that loaded a run while its orchestration was being deleted. The
 * delete takes the run's row with it, so no entry point hands a driver such a
 * run on purpose; the interleaving is a race between the delete and a worker,
 * the scheduler or a resume request, which HTTP cannot order. Each driver is
 * handed the in-memory run the race leaves behind.
 */

type RunInstance = InstanceType<typeof db.OrchestrationRun>;

let userToken: string;
let projectPk: number;
let projectId: string;
let orchSeq = 0;

/** A run row whose orchestration is then deleted through the API. */
const runOfDeletedOrchestration = async (
  overrides: Record<string, unknown>
): Promise<RunInstance> => {
  orchSeq += 1;
  const created = await authenticatedTestClient(userToken)
    .post('/api/v1/orchestrations')
    .send({
      project_id: projectId,
      name: `Deleted Mid Run ${orchSeq}`,
      nodes: [{ id: 'start', type: 'transform', expression: 'x' }],
      edges: [],
    });
  expect(created.status).toBe(201);
  const orchestration = await db.Orchestration.findOne({
    where: { publicId: created.body.id },
  });
  const run = await db.OrchestrationRun.create({
    orchestrationId: orchestration!.id as number,
    orchestrationVersion: 1,
    projectId: projectPk,
    state: {},
    activeNodes: [],
    artifacts: {},
    input: {},
    ...overrides,
  });

  const deleted = await authenticatedTestClient(userToken).delete(
    `/api/v1/orchestrations/${created.body.id}`
  );
  expect(deleted.status).toBe(204);
  return run;
};

beforeAll(async () => {
  const setup = await setupProjectWithUsers({
    prefix: 'orchdeleted',
    policyActions: [
      'orchestrations:CreateOrchestration',
      'orchestrations:DeleteOrchestration',
    ],
    createNoPermUser: false,
  });
  userToken = setup.userToken;
  projectId = setup.projectId;
  const project = await db.Project.findOne({ where: { publicId: projectId } });
  projectPk = project!.id as number;
});

describe('a background driver handed a run whose orchestration is gone', () => {
  const LEASE = new Date(Date.now() - 60_000);
  const WAKE_CONTEXT = {
    nodeId: 'delay',
    resume: { kind: 'delay', artifact: {} },
  };

  // One terminal state for all three: a failed run holds neither a lease the
  // reaper would act on nor a wake the scheduler would.
  test.each<
    [string, Record<string, unknown>, (run: RunInstance) => Promise<void>]
  >([
    [
      'driveQueuedRun',
      { status: 'queued', leaseExpiresAt: LEASE, wakeContext: WAKE_CONTEXT },
      (run) => {
        return driveQueuedRun({ run });
      },
    ],
    [
      'wakeRun',
      {
        status: 'sleeping',
        wakeAt: new Date(Date.now() - 1000),
        leaseExpiresAt: LEASE,
        wakeContext: WAKE_CONTEXT,
      },
      (run) => {
        return wakeRun({ run });
      },
    ],
    [
      'redriveRun',
      { status: 'running', leaseExpiresAt: LEASE, wakeContext: WAKE_CONTEXT },
      (run) => {
        return redriveRun({ run });
      },
    ],
  ])(
    '%s fails it, clearing the lease and the wake',
    async (_name, overrides, drive) => {
      const run = await runOfDeletedOrchestration(overrides);

      await drive(run);

      expect(run.status).toBe('failed');
      expect(run.leaseExpiresAt).toBeNull();
      expect(run.wakeAt).toBeNull();
      expect(run.wakeContext).toBeNull();
      expect(run.completedAt).toBeInstanceOf(Date);
      expect(run.error).toEqual({
        code: 'ORCHESTRATION_NOT_FOUND',
        message: 'Orchestration gone',
      });
    }
  );
});

describe('a resume handed a run whose orchestration is gone', () => {
  test('throws, so the request answers with the error', async () => {
    const run = await runOfDeletedOrchestration({ status: 'awaiting_input' });

    await expect(resumeOrchestrationRunExecution({ run })).rejects.toThrow(
      new DomainError(
        'ORCHESTRATION_NOT_FOUND',
        'Orchestration for run not found.'
      )
    );
  });
});
