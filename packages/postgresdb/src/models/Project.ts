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

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
