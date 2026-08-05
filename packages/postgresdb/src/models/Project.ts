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

  // Public IDs of guardrails attached at the project scope — the baseline /
  // central-mandate floor governing every tool call by every agent in the
  // project (guardrails.md — Attachment).
  @Column({ type: DataType.JSONB, allowNull: true })
  declare guardrailIds: string[] | null;

  // Maximum number of orchestration runs of this project that may be actively
  // driven at once. `null` (the default) means unlimited. Enforced at queue
  // claim time: while the project has this many runs holding a claimed,
  // lease-valid task, further tasks stay queued until a slot frees. Only
  // actively-driven runs occupy a slot — parked (`sleeping`/`awaiting_input`)
  // runs hold none (orchestration-queue PRD, D8/D9).
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare maxConcurrentRuns: number | null;

  // Public ID of the model route inherited by consumers in this project that
  // name neither a route nor an AI provider (model-routing PRD, Phase 3).
  // `null` means no default — every consumer must then bind explicitly.
  //
  // Stored as the route's public id rather than an `@ForeignKey` to the internal
  // id, mirroring `guardrailIds` above: `ModelRoute` already belongs to
  // `Project`, so a foreign key here would close a cycle between the two tables
  // that `sync()` cannot create. Referential integrity is enforced at write
  // time instead — the route must belong to the project, and `deleteModelRoute`
  // refuses to drop a route a project defaults to.
  @Column({ type: DataType.STRING(32), allowNull: true })
  declare defaultModelRouteId: string | null;

  // Opts the project into read auditing: when true, `GET` requests that name
  // this project are recorded in the audit log alongside mutations. Off by
  // default — reads are high-volume and low-value, so v1 records mutations only
  // (audit-log PRD, Phase 3).
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare auditReadsEnabled: boolean;

  // How long trace/generation content is kept before the daily retention sweep
  // content-purges it. `null` (the default) disables retention entirely, so
  // nothing a project already stored is destroyed by shipping this feature —
  // a tenant opts in (#837).
  //
  // Scoped to the project rather than the agent on purpose: a purge cascades
  // down the trace subtree (`purgeTraceContent`), and nested agent calls create
  // child traces owned by *other* agents. A per-agent window would therefore
  // let a short-window root silently purge a child whose own agent asked for a
  // longer one. Every trace in a subtree shares one project, so the
  // project-scoped window has no such conflict.
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare traceContentRetentionDays: number | null;

  // Zero-retention floor for the project: `'none'` means trace/generation
  // content is never written in the first place, for every agent in the
  // project (#838). An agent may tighten this to `'none'` on its own, never
  // loosen it — the same "project sets the floor, the agent narrows" shape
  // `guardrailIds` above already uses.
  @Column({
    type: DataType.STRING(16),
    allowNull: false,
    defaultValue: 'full',
  })
  declare traceContentMode: string;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
