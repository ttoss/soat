import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  HasMany,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Project } from './Project';
import { ShareAcceptance } from './ShareAcceptance';

/**
 * A publisher project's offer to let another project — or any project, when
 * `grantee` is `*` — invoke one of its resources with the listed actions. It
 * grants nothing until the grantee writes a {@link ShareAcceptance}.
 *
 * The resource is named by type and public id rather than by foreign key: the
 * shareable types live in different tables, and a revoked share outlives the
 * resource it named.
 */
@Table({
  tableName: 'shares',
  indexes: [
    {
      name: 'shares_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    {
      name: 'shares_project_id_idx',
      fields: ['project_id'],
    },
    {
      name: 'shares_resource_type_resource_id_idx',
      fields: ['resource_type', 'resource_id'],
    },
    {
      name: 'shares_grantee_idx',
      fields: ['grantee'],
    },
  ],
  hooks: {
    beforeValidate: (instance: Share) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.share);
      }
    },
  },
})
export class Share extends Model {
  @Column({
    type: DataType.STRING(32),
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return Project;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare projectId: number;

  @BelongsTo(() => {
    return Project;
  })
  declare project: Project;

  // A string, not an enum: the shareable types are a registry in code, and a
  // new one must not need a schema change.
  @Column({ type: DataType.STRING(32), allowNull: false })
  declare resourceType: string;

  @Column({ type: DataType.STRING(32), allowNull: false })
  declare resourceId: string;

  @Column({ type: DataType.JSONB, allowNull: false })
  declare actions: string[];

  // A project public id, or `*`. Not a foreign key: a share names its grantee
  // without confirming to the publisher that the project exists.
  @Column({ type: DataType.STRING(32), allowNull: false })
  declare grantee: string;

  @Column({ type: DataType.DATE, allowNull: true })
  declare suspendedAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare revokedAt: Date | null;

  @HasMany(() => {
    return ShareAcceptance;
  })
  declare acceptances: ShareAcceptance[];

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
