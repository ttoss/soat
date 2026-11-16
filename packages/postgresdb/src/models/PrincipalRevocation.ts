import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { Project } from './Project';

/**
 * An opaque principal (an IAM token's `principal`, an `On-Behalf-Of`
 * assertion's) revoked in one project: work acting for it resolves no caller.
 * Internal: never exposed, no `publicId`.
 */
@Table({
  tableName: 'principal_revocations',
  updatedAt: false,
})
export class PrincipalRevocation extends Model {
  @ForeignKey(() => {
    return Project;
  })
  @Column({ type: DataType.INTEGER, allowNull: false, primaryKey: true })
  declare projectId: number;

  @BelongsTo(
    () => {
      return Project;
    },
    { onDelete: 'CASCADE' }
  )
  declare project: Project;

  @Column({ type: DataType.STRING(255), allowNull: false, primaryKey: true })
  declare principalType: string;

  @Column({ type: DataType.STRING(255), allowNull: false, primaryKey: true })
  declare principalId: string;

  declare createdAt: Date;
}
