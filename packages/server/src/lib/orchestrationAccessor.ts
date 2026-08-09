/**
 * The orchestration cluster's two loaded-row shapes and the scoped accessors
 * between them.
 *
 * A leaf module by design: it imports `db` and `resourceAccessor` and nothing
 * else, so `orchestrations.ts`, `orchestrationRunActions.ts`,
 * `orchestrationStartRun.ts` and `orchestrationVersions.ts` can all reach the
 * same scoped lookup without any of them importing another — the cluster
 * already has enough import cycles (#910).
 *
 * ## Why one place matters here specifically
 *
 * These four modules spelled the *same* scope rule three different ways:
 * `!== undefined`, a truthy `if (args.projectIds)`, and
 * `args.projectIds && args.projectIds.length > 0`. The third is not a stylistic
 * variant — it drops the `projectId` filter entirely for an empty scope, so an
 * empty credential scope would have read across every project instead of
 * matching nothing. `scopedWhere` gives all four the one answer.
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
