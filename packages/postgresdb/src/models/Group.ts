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
 * A group of projects: an authorization scope above the project. Its own
 * resources are named `srn:group:<group_id>:<type>/<id>`.
 */
@Table({
  tableName: 'groups',
  indexes: [
    {
      name: 'groups_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    { name: 'groups_owner_user_id_idx', fields: ['owner_user_id'] },
  ],
  hooks: {
    beforeValidate: (instance: Group) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.group);
      }
    },
  },
})
export class Group extends Model {
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

  /** The user holding the group's own resources. */
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

  /** Public ids of the policies the owner attached; they cap the group. */
  @Column({
    type: DataType.ARRAY(DataType.STRING),
    allowNull: false,
    defaultValue: [],
  })
  declare policyIds: string[];

  /**
   * Public ids of the global policies the operator attached; they cap the
   * group beside `policyIds`, and only the operator writes them.
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
