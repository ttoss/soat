import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Guardrail } from './Guardrail';
import { User } from './User';

/**
 * Immutable archive of a guardrail's configuration at a given version. A new row
 * is written by the shared lib write path on every write that actually changes
 * the policy; existing rows are never mutated, so the audit chain (approval
 * items, activity entries) can reference the exact document that governed them.
 * A restore appends a new version rather than rewinding the counter, so there is
 * no `updatedAt`.
 *
 * Shares its column layout — and the lib engine that reads and writes it — with
 * `AgentVersion` (`src/lib/resourceVersions.ts`). The table stays separate so the
 * foreign key to `guardrails` is a real one.
 */
@Table({
  tableName: 'guardrail_versions',
  indexes: [
    {
      name: 'guardrail_versions_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    // Serves the point lookup and the newest-first listing, so no separate
    // index on `created_at` is needed.
    {
      name: 'guardrail_versions_guardrail_id_version_unique',
      unique: true,
      fields: ['guardrail_id', 'version'],
    },
  ],
  updatedAt: false,
  hooks: {
    beforeValidate: (instance: GuardrailVersion) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(
          PUBLIC_ID_PREFIXES.guardrailVersion
        );
      }
    },
  },
})
export class GuardrailVersion extends Model {
  @Column({
    type: DataType.STRING(32),
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return Guardrail;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare guardrailId: number;

  @BelongsTo(() => {
    return Guardrail;
  })
  declare guardrail: Guardrail;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare version: number;

  /**
   * The guardrail's versioned surface, stored in the wire (snake_case) shape the
   * guardrails OpenAPI spec documents: `{ document }`.
   *
   * Only the policy `document` is versioned. Name, description and the context
   * binding are metadata — bumping the version when one of them changes would
   * make two version numbers denote the same policy, and the version number is
   * exactly what an evaluation record cites to say which policy governed it.
   */
  @Column({ type: DataType.JSONB, allowNull: false })
  declare config: object;

  /** Optional human tag for this version, e.g. `pre-tightening`. */
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
