import { db } from 'src/db';

import { authenticatedTestClient } from '../testClient';
import { setupProjectWithUsers } from './bootstrap';

export type RunInstance = InstanceType<typeof db.OrchestrationRun>;

/**
 * The in-memory run a race between `DELETE /orchestrations/:id` and a driver
 * leaves behind. The delete takes the run's row with it, so no entry point
 * hands a driver such a run on purpose; the interleaving is one HTTP cannot
 * order, and this builds it: a run row is created, then its orchestration is
 * deleted through the API while the instance stays loaded.
 */
export const setupDeletedOrchestrationRuns = async (args: {
  prefix: string;
}) => {
  const setup = await setupProjectWithUsers({
    prefix: args.prefix,
    policyActions: [
      'orchestrations:CreateOrchestration',
      'orchestrations:DeleteOrchestration',
    ],
    createNoPermUser: false,
  });
  const project = await db.Project.findOne({
    where: { publicId: setup.projectId },
  });
  const projectPk = project!.id as number;
  let seq = 0;

  const runOfDeletedOrchestration = async (
    overrides: Record<string, unknown>
  ): Promise<RunInstance> => {
    seq += 1;
    const created = await authenticatedTestClient(setup.userToken)
      .post('/api/v1/orchestrations')
      .send({
        project_id: setup.projectId,
        name: `${args.prefix} Deleted Mid Run ${seq}`,
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

    const deleted = await authenticatedTestClient(setup.userToken).delete(
      `/api/v1/orchestrations/${created.body.id}`
    );
    expect(deleted.status).toBe(204);
    return run;
  };

  return { runOfDeletedOrchestration };
};
