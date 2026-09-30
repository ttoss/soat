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
import { Share } from './Share';

/**
 * A grantee project's acceptance of a {@link Share}: one row per consuming
 * project, so a public share still has a consumer the publisher can list and
 * revoke one by one.
 *
 * A revoked row is kept. `revokedBy: 'publisher'` is what refuses the same
 * project's next accept until the publisher deletes the row.
 */
@Table({
  tableName: 'share_acceptances',
  indexes: [
    {
      name: 'share_acceptances_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    {
      name: 'share_acceptances_share_id_project_id_unique',
      unique: true,
      fields: ['share_id', 'project_id'],
    },
    {
      name: 'share_acceptances_project_id_idx',
      fields: ['project_id'],
    },
  ],
  hooks: {
    beforeValidate: (instance: ShareAcceptance) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(
          PUBLIC_ID_PREFIXES.shareAcceptance
        );
      }
    },
  },
})
export class ShareAcceptance extends Model {
  @Column({
    type: DataType.STRING(32),
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return Share;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare shareId: number;

  @BelongsTo(
    () => {
      return Share;
    },
    { onDelete: 'CASCADE' }
  )
  declare share: Share;

  // The grantee. CASCADE: a deleted consumer project takes its acceptances
  // with it and leaves the publisher's share alone.
  @ForeignKey(() => {
    return Project;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare projectId: number;

  @BelongsTo(
    () => {
      return Project;
    },
    { onDelete: 'CASCADE' }
  )
  declare project: Project;

  @Column({
    type: DataType.ENUM('active', 'revoked'),
    allowNull: false,
    defaultValue: 'active',
  })
  declare status: 'active' | 'revoked';

  @Column({
    type: DataType.ENUM('publisher', 'consumer'),
    allowNull: true,
  })
  declare revokedBy: 'publisher' | 'consumer' | null;

  @Column({ type: DataType.DATE, allowNull: false })
  declare acceptedAt: Date;

  @Column({ type: DataType.DATE, allowNull: true })
  declare revokedAt: Date | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
