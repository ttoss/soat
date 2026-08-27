/**
 * The orchestration cluster's two loaded-row shapes and the scoped accessors
 * between them.
 *
 * A leaf module by design — it imports `db` and `resourceAccessor` and nothing
 * else — so the four orchestration modules can share a scoped lookup without
 * importing one another; the cluster already has enough cycles (#910).
 *
 * Those four spelled the same scope rule three ways: `!== undefined`, a truthy
 * `if`, and `projectIds && projectIds.length > 0`. The third is not a stylistic
 * variant — it drops the filter for an empty scope, so an empty credential
 * scope would read across every project instead of matching nothing.
 */
import { db } from '../db';
import { makeResourceAccessor } from './resourceAccessor';

/**
 * Sequelize include for the per-node execution records of a run, ordered
 * oldest-first. Returned as a function because `db` is populated at runtime.
 */
export const nodeExecutionsInclude = (): object => {
  return {
    model: db.OrchestrationNodeExecution,
    as: 'nodeExecutions',
    separate: true,
    order: [['createdAt', 'ASC']],
  };
};

export type OrchestrationRow = InstanceType<typeof db.Orchestration> & {
  project: InstanceType<typeof db.Project>;
};

export type OrchestrationRunRow = InstanceType<typeof db.OrchestrationRun> & {
  orchestration: InstanceType<typeof db.Orchestration>;
  project: InstanceType<typeof db.Project>;
};

export const orchestrations = makeResourceAccessor<OrchestrationRow>({
  model: () => {
    return db.Orchestration;
  },
  includes: () => {
    return [{ model: db.Project, as: 'project' }];
  },
  label: 'Orchestration',
  errorCode: 'ORCHESTRATION_NOT_FOUND',
});

export const orchestrationRuns = makeResourceAccessor<OrchestrationRunRow>({
  model: () => {
    return db.OrchestrationRun;
  },
  includes: () => {
    return [
      { model: db.Project, as: 'project' },
      { model: db.Orchestration, as: 'orchestration' },
    ];
  },
  label: 'Run',
  errorCode: 'ORCHESTRATION_RUN_NOT_FOUND',
});
