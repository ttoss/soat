import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Orchestration } from './Orchestration';
import { User } from './User';

/**
 * Immutable archive of an orchestration's graph at a given version. A new row is
 * written by the shared lib write path on every write that actually changes the
 * graph; existing rows are never mutated, so a run can be pinned to the exact
 * topology it started on (issue #872) and `node_executions` always reference node
 * ids from a graph that still exists. A restore appends a new version rather than
 * rewinding the counter, so there is no `updatedAt`.
 *
 * Shares its column layout — and the lib engine that reads and writes it — with
 * `AgentVersion` and `GuardrailVersion` (`src/lib/resourceVersions.ts`). The
 * table stays separate so the foreign key to `orchestrations` is a real one.
 */
@Table({
  tableName: 'orchestration_versions',
  indexes: [
    {
      name: 'orchestration_versions_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    // Serves both the point lookup of one version — which every background
    // execution of a pinned run performs — and the newest-first paginated
    // listing (`WHERE orchestration_id = ? ORDER BY version DESC`), so no
    // separate index on `created_at` is needed.
    {
      name: 'orchestration_versions_orchestration_id_version_unique',
      unique: true,
      fields: ['orchestration_id', 'version'],
    },
  ],
  updatedAt: false,
  hooks: {
    beforeValidate: (instance: OrchestrationVersion) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(
          PUBLIC_ID_PREFIXES.orchestrationVersion
        );
      }
    },
  },
})
export class OrchestrationVersion extends Model {
  @Column({
    type: DataType.STRING(32),
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return Orchestration;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare orchestrationId: number;

  @BelongsTo(() => {
    return Orchestration;
  })
  declare orchestration: Orchestration;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare version: number;

  /**
   * The orchestration's versioned surface, stored in the wire (snake_case) shape
   * the orchestrations OpenAPI spec documents: `{ nodes, edges, state_schema,
   * input_schema }`.
   *
   * Only the graph is versioned. Name and description are metadata — bumping the
   * version when one of them changes would make two version numbers denote the
   * same topology, and the version number is exactly what a run cites to say
   * which topology it executed.
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
