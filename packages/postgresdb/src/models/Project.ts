import { Column, DataType, Model, Table } from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';

@Table({
  tableName: 'projects',
  indexes: [
    {
      name: 'projects_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
  ],
  hooks: {
    beforeValidate: (instance: Project) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.project);
      }
    },
  },
})
export class Project extends Model {
  @Column({
    type: DataType.STRING(32),
    allowNull: false,
  })
  declare publicId: string;

  @Column({
    type: DataType.STRING,
    allowNull: false,
  })
  declare name: string;

  // The baseline floor governing every tool call by every agent in the project.
  @Column({ type: DataType.JSONB, allowNull: true })
  declare guardrailIds: string[] | null;

  // Concurrently-driven runs allowed, `null` for unlimited. Enforced at queue
  // claim time; parked (`sleeping`/`awaiting_input`) runs occupy no slot.
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare maxConcurrentRuns: number | null;

  // Generations one continuation chain may hold before the platform stops
  // resuming it, `null` to defer to the deployment-wide ceiling. Every ceiling
  // (deployment, project, agent) can only make the budget smaller, so this is
  // the operator's bound on chains an agent author cannot opt out of.
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare maxChainGenerations: number | null;

  // `loop` / `sub_orchestration` nesting levels a run tree may reach before the
  // engine refuses to start the next child, `null` to defer to the
  // deployment-wide ceiling. Like `maxChainGenerations`, every ceiling can only
  // make the bound smaller, so this is the operator's bound on a self-
  // referencing graph that a graph author cannot opt out of.
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare maxOrchestrationRunDepth: number | null;

  // Inherited by consumers naming neither a route nor a provider; `null` forces
  // every consumer to bind explicitly. A public id rather than an
  // `@ForeignKey`, because `ModelRoute` already belongs to `Project` and the FK
  // would close a cycle `sync()` cannot create — integrity is enforced at write
  // time, and `deleteModelRoute` refuses to drop a route a project defaults to.
  @Column({ type: DataType.STRING(32), allowNull: true })
  declare defaultModelRouteId: string | null;

  // What a conversation that names no `retrieval` of its own does. `none` by
  // default: a turn is embedded because someone asked for it to be retrievable,
  // never merely because it was said.
  @Column({
    type: DataType.STRING(8),
    allowNull: false,
    defaultValue: 'none',
  })
  declare defaultConversationRetrieval: 'embed' | 'none';

  // Opts into auditing `GET`s alongside mutations. Off by default — reads are
  // high-volume and low-value.
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare auditReadsEnabled: boolean;

  // Refuses a generation whose model carries no price row, so spend this
  // project cannot measure is never started. Off by default: a deployment that
  // keeps no price book at all meters at `cost_usd = null` and still runs.
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare requirePricedModel: boolean;

  // `null` disables retention, so shipping this destroyed nothing already
  // stored — a tenant opts in. Scoped to the project, not the agent: a
  // purge cascades down the trace subtree, and nested calls create child traces
  // owned by other agents, so a per-agent window would let a short-window root
  // purge a child that asked for a longer one.
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare traceContentRetentionDays: number | null;

  // `'none'` means content is never written at all, for every agent in the
  // project. An agent may tighten to `'none'`, never loosen — the same
  // "project sets the floor, the agent narrows" shape as `guardrailIds`.
  @Column({
    type: DataType.STRING(16),
    allowNull: false,
    defaultValue: 'full',
  })
  declare traceContentMode: string;

  // Set while a project-wide pause is in force: no new generation, run, eval
  // run, tool call or trigger firing starts in the project, and the schedule
  // and eval drivers skip it. `resume` is the only thing that clears it.
  @Column({ type: DataType.DATE, allowNull: true })
  declare pausedAt: Date | null;

  @Column({ type: DataType.STRING(256), allowNull: true })
  declare pauseReason: string | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
