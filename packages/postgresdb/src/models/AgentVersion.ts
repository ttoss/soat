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
import { EvalRun } from './EvalRun';

/**
 * Immutable archive of an agent's mutable configuration at a given version. A
 * new row is written by the shared lib update path on every write that actually
 * changes the config, so a REST edit and a formation apply both leave history
 * and a generation can always be traced back to the exact config that served it.
 * A row's `config` is not rewritten: a restore appends a new version rather than
 * rewinding the counter. The one later write is a promotion stamping what it
 * stood on (`evalRunId`, `claims`, `releasedClaims`) on the version it made
 * live, which is why there is no `updatedAt` to track config changes.
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
    // Serves the point lookup and the newest-first listing, so no separate
    // index on `created_at` is needed.
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
  @Column({ type: DataType.JSON, allowNull: false })
  declare config: object;

  /** Optional human tag for this version, e.g. `tone-change`. */
  @Column({ type: DataType.STRING, allowNull: true })
  declare label: string | null;

  /**
   * The eval run that validated this version, set when an eval-gated promotion
   * made it live (agents module doc — Eval-Gated Promotion). Null for every
   * version that was not promoted through a gate — which is most of them.
   *
   * `SET NULL` rather than `CASCADE`: the run is provenance for a config that
   * is live in production, so deleting the run must not delete the config it
   * validated.
   */
  @ForeignKey(() => {
    return EvalRun;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare evalRunId: number | null;

  @BelongsTo(
    () => {
      return EvalRun;
    },
    { onDelete: 'SET NULL' }
  )
  declare evalRun: EvalRun | null;

  /**
   * Eval ids of the claims the release gave up when it promoted this
   * version. Null for a version no promotion made live.
   */
  @Column({ type: DataType.JSON, allowNull: true, defaultValue: null })
  declare releasedClaims: string[] | null;

  /**
   * The claims the promoted canary version held when a promotion made this
   * version live, each as the claims read served it then. A copy: production
   * keeps moving the claims read, and this records what the promotion stood
   * on. Null for a version no promotion made live.
   */
  @Column({ type: DataType.JSON, allowNull: true, defaultValue: null })
  declare claims: Record<string, unknown>[] | null;

  /** Who produced this version; null for a write with no principal. */
  @Column({ type: DataType.STRING(16), allowNull: true })
  declare createdByPrincipalType: string | null;

  @Column({ type: DataType.STRING(32), allowNull: true })
  declare createdByPrincipalId: string | null;

  /** Whom that principal acted for: an IAM token's or `On-Behalf-Of` principal. */
  @Column({ type: DataType.STRING(255), allowNull: true })
  declare createdByActsForType: string | null;

  @Column({ type: DataType.STRING(255), allowNull: true })
  declare createdByActsForId: string | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;
}
