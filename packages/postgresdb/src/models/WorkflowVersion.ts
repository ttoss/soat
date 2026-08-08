import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { User } from './User';
import { Workflow } from './Workflow';

/**
 * Immutable archive of a workflow's state machine at a given version. A new row
 * is written by the shared lib write path on every write that actually changes
 * the definition; existing rows are never mutated, so a task can be pinned to the
 * exact machine it entered on (issue #882) and a task parked for weeks still
 * transitions on states and transitions that still exist. A restore appends a new
 * version rather than rewinding the counter, so there is no `updatedAt`.
 *
 * Shares its column layout — and the lib engine that reads and writes it — with
 * `AgentVersion`, `GuardrailVersion` and `OrchestrationVersion`
 * (`src/lib/resourceVersions.ts`). The table stays separate so the foreign key to
 * `workflows` is a real one.
 */
@Table({
  tableName: 'workflow_versions',
  indexes: [
    {
      name: 'workflow_versions_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    // Serves both the point lookup of one version — which every transition of a
    // pinned task performs — and the newest-first paginated listing
    // (`WHERE workflow_id = ? ORDER BY version DESC`), so no separate index on
    // `created_at` is needed.
    {
      name: 'workflow_versions_workflow_id_version_unique',
      unique: true,
      fields: ['workflow_id', 'version'],
    },
  ],
  updatedAt: false,
  hooks: {
    beforeValidate: (instance: WorkflowVersion) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(
          PUBLIC_ID_PREFIXES.workflowVersion
        );
      }
    },
  },
})
export class WorkflowVersion extends Model {
  @Column({
    type: DataType.STRING(32),
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return Workflow;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare workflowId: number;

  @BelongsTo(() => {
    return Workflow;
  })
  declare workflow: Workflow;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare version: number;

  /**
   * The workflow's versioned surface, stored in the wire (snake_case) shape the
   * workflows OpenAPI spec documents: `{ states, transitions, payload_schema }`.
   *
   * Only the state machine is versioned. Name and description are metadata —
   * bumping the version when one of them changes would make two version numbers
   * denote the same machine, and the version number is exactly what a task cites
   * to say which machine it is living in.
   */
  @Column({ type: DataType.JSONB, allowNull: false })
  declare config: object;

  /** Optional human tag for this version, e.g. `pre-rewire`. */
  @Column({ type: DataType.STRING, allowNull: true })
  declare label: string | null;

  /**
   * The user whose action produced this version. Null for writes with no
   * request user behind them.
   */
  @ForeignKey(() => {
    return User;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare createdByUserId: number | null;

  @BelongsTo(() => {
    return User;
  })
  declare createdBy: User | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;
}
