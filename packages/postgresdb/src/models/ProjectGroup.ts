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

/**
 * A project group: an authorization scope above the project. Its own
 * resources are named `srn:project-group:<project_group_id>:<type>/<id>`.
 */
@Table({
  tableName: 'project_groups',
  indexes: [
    {
      name: 'project_groups_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    { name: 'project_groups_owner_user_id_idx', fields: ['owner_user_id'] },
  ],
  hooks: {
    beforeValidate: (instance: ProjectGroup) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.projectGroup);
      }
    },
  },
})
export class ProjectGroup extends Model {
  @Column({
    type: DataType.STRING(32),
    allowNull: false,
  })
  declare publicId: string;

  @Column({
    type: DataType.STRING,
    allowNull: false,
  })
  declare name: string;

  /** The user holding the project group's own resources. */
  @ForeignKey(() => {
    return User;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare ownerUserId: number;

  @BelongsTo(
    () => {
      return User;
    },
    { foreignKey: 'ownerUserId', as: 'owner', onDelete: 'CASCADE' }
  )
  declare owner: User;

  /** Public ids of the policies the owner attached; they cap the project group. */
  @Column({
    type: DataType.ARRAY(DataType.STRING),
    allowNull: false,
    defaultValue: [],
  })
  declare policyIds: string[];

  /**
   * Public ids of the global policies the operator attached; they cap the
   * project group beside `policyIds`, and only the operator writes them.
   */
  @Column({
    type: DataType.ARRAY(DataType.STRING),
    allowNull: false,
    defaultValue: [],
  })
  declare fixedPolicyIds: string[];

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
