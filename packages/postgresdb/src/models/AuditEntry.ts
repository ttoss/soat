import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Project } from './Project';

const APPEND_ONLY_MESSAGE =
  'AuditEntry is append-only; rows cannot be updated.';

/**
 * One immutable audit record per authorized (or denied) mutating action,
 * attributed to the principal that made the request. `action` is the
 * permission-action that authorized it and `resourceSrn` the SRN it targeted,
 * so the log reuses the permission registry as its vocabulary.
 *
 * A few entries describe platform-originated events no principal authorized
 * (a monitor-mode quota breach). Those leave `principalType`/`principalId`
 * null and are identified by their `action` — the principal columns never hold
 * a synthetic value. (Named `principal*`, not `actor*`, to avoid confusion with
 * the unrelated Actor resource.)
 *
 * Append-only: the model hooks reject every UPDATE and single-row DELETE; the
 * sole deletion path is the retention sweep's bulk `destroy({ where })`.
 */
@Table({
  tableName: 'audit_entries',
  updatedAt: false,
  indexes: [
    {
      name: 'audit_entries_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    {
      name: 'audit_entries_project_id_created_at_idx',
      fields: ['project_id', 'created_at'],
    },
    {
      name: 'audit_entries_principal_id_created_at_idx',
      fields: ['principal_id', 'created_at'],
    },
    {
      name: 'audit_entries_action_created_at_idx',
      fields: ['action', 'created_at'],
    },
    {
      name: 'audit_entries_resource_public_id_created_at_idx',
      fields: ['resource_public_id', 'created_at'],
    },
  ],
  hooks: {
    beforeValidate: (instance: AuditEntry) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.auditEntry);
      }
    },
    beforeUpdate: () => {
      throw new Error(APPEND_ONLY_MESSAGE);
    },
    beforeBulkUpdate: () => {
      throw new Error(APPEND_ONLY_MESSAGE);
    },
    beforeDestroy: () => {
      throw new Error(
        'AuditEntry rows can only be removed by the retention sweep.'
      );
    },
  },
})
export class AuditEntry extends Model {
  @Column({
    type: DataType.STRING(32),
    allowNull: false,
  })
  declare publicId: string;

  // Nullable: global actions (e.g. `users:CreateUser`) have no project.
  @ForeignKey(() => {
    return Project;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare projectId: number | null;

  @BelongsTo(() => {
    return Project;
  })
  declare project: Project | null;

  /**
   * `user` | `api_key` — the kind of principal that made the request. Null for
   * platform-originated (non-principal) entries. Only ever holds a real
   * principal kind, never a synthetic sentinel. Named `principalType` (not
   * `actorType`) to avoid confusion with the unrelated Actor resource.
   */
  @Column({ type: DataType.STRING, allowNull: true })
  declare principalType: string | null;

  /**
   * Public id of the principal (`user_…` / `key_…`). Null for
   * platform-originated entries (identified by their `action` instead).
   */
  @Column({ type: DataType.STRING, allowNull: true })
  declare principalId: string | null;

  /** The permission-action string that authorized the request. */
  @Column({ type: DataType.STRING, allowNull: false })
  declare action: string;

  /**
   * SRN the action targeted (`soat:{project}:{type}:{id}`; type-level
   * `soat:{project}:{type}:*` on creates). Null for actions with no resource.
   */
  @Column({ type: DataType.STRING, allowNull: true })
  declare resourceSrn: string | null;

  /**
   * Denormalized from the SRN's last segment; on creates, captured from the
   * response body `id`.
   */
  @Column({ type: DataType.STRING, allowNull: true })
  declare resourcePublicId: string | null;

  /** HTTP status of the response (recorded post-commit). */
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare status: number;

  /** Per-request correlation id (echoed in the `X-Request-Id` header). */
  @Column({ type: DataType.STRING, allowNull: true })
  declare requestId: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare ip: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare userAgent: string | null;

  /** Kind-specific payload; guardrail evaluation records live here. */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare detail: Record<string, unknown> | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;
}
