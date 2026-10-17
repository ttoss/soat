import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { PlaybookCase } from './PlaybookCase';

/**
 * One run of one node of a case: what it read (`basis`), what it started
 * (`runId`) and how it settled. Its output is written as an entry; an execution
 * whose inputs moved while it ran is kept as `superseded` and writes none.
 */
@Table({
  tableName: 'playbook_executions',
  indexes: [
    {
      name: 'playbook_executions_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    {
      name: 'playbook_executions_case_id_node_idx',
      fields: ['case_id', 'node', 'id'],
    },
    {
      name: 'playbook_executions_run_id_idx',
      fields: ['executor_type', 'run_id'],
    },
    {
      name: 'playbook_executions_status_lease_idx',
      fields: ['status', 'lease_expires_at'],
    },
  ],
  hooks: {
    beforeValidate: (instance: PlaybookExecution) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(
          PUBLIC_ID_PREFIXES.playbookExecution
        );
      }
    },
  },
})
export class PlaybookExecution extends Model {
  @Column({
    type: DataType.STRING(32),
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return PlaybookCase;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare caseId: number;

  @BelongsTo(
    () => {
      return PlaybookCase;
    },
    { onDelete: 'CASCADE' }
  )
  declare case: PlaybookCase;

  /** The node key, stable across playbook versions. */
  @Column({ type: DataType.STRING, allowNull: false })
  declare node: string;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare playbookVersion: number;

  /** `agent` | `tool` | `decider` | `workflow` | `orchestration`; null for a `collect` node. */
  @Column({ type: DataType.STRING(16), allowNull: true })
  declare executorType: string | null;

  @Column({ type: DataType.STRING(64), allowNull: true })
  declare executorId: string | null;

  /** The generation, decision, task or orchestration run it started. */
  @Column({ type: DataType.STRING(64), allowNull: true })
  declare runId: string | null;

  /** `pending` | `running` | `succeeded` | `failed`. */
  @Column({ type: DataType.STRING(16), allowNull: false })
  declare status: string;

  /** `current` | `superseded`, once settled. */
  @Column({ type: DataType.STRING(16), allowNull: true })
  declare result: string | null;

  /** The revision of every input it read. */
  @Column({ type: DataType.JSONB, allowNull: false })
  declare basis: object;

  /** `JSON`, not `JSONB`, so an object reads back in its key order. */
  @Column({ type: DataType.JSON, allowNull: true })
  declare input: unknown;

  @Column({ type: DataType.JSON, allowNull: true })
  declare output: unknown;

  /** The output entry it wrote; null when it wrote none. */
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare outputRevision: number | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare error: object | null;

  /** Who asked for the run; null when the case started it. */
  @Column({ type: DataType.STRING(16), allowNull: true })
  declare createdByPrincipalType: string | null;

  @Column({ type: DataType.STRING(32), allowNull: true })
  declare createdByPrincipalId: string | null;

  /**
   * Until when a `running` execution is known alive: extended while a worker
   * runs it, and the next re-read of a task or run it waits on. A sweep
   * recovers it once past.
   */
  @Column({ type: DataType.DATE, allowNull: true })
  declare leaseExpiresAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare finishedAt: Date | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
