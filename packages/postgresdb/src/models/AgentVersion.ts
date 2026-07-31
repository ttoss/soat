import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Agent } from './Agent';
import { User } from './User';

/**
 * Immutable archive of an agent's mutable configuration at a given version. A
 * new row is written by the shared lib update path on every write that actually
 * changes the config, so a REST edit and a formation apply both leave history
 * and a generation can always be traced back to the exact config that served it.
 * Rows are never mutated — a restore appends a new version rather than rewinding
 * the counter — so there is no `updatedAt`.
 *
 * Mirrors `GuardrailVersion`.
 */
@Table({
  tableName: 'agent_versions',
  indexes: [
    {
      name: 'agent_versions_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    // Serves both the point lookup of one version and the newest-first
    // paginated listing (`WHERE agent_id = ? ORDER BY version DESC`), so no
    // separate index on `created_at` is needed.
    {
      name: 'agent_versions_agent_id_version_unique',
      unique: true,
      fields: ['agent_id', 'version'],
    },
  ],
  updatedAt: false,
  hooks: {
    beforeValidate: (instance: AgentVersion) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.agentVersion);
      }
    },
  },
})
export class AgentVersion extends Model {
  @Column({
    type: DataType.STRING(32),
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return Agent;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare agentId: number;

  @BelongsTo(() => {
    return Agent;
  })
  declare agent: Agent;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare version: number;

  /**
   * The agent's mutable surface, stored in the wire (snake_case) shape the
   * agents OpenAPI spec documents. Serialized by the same mapper that builds an
   * agent response, so a new API field lands in new snapshots automatically and
   * the two can never drift.
   */
  @Column({ type: DataType.JSONB, allowNull: false })
  declare config: object;

  /** Optional human tag for this version, e.g. `pre-tone-change`. */
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
