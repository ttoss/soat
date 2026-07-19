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
import { User } from './User';

@Table({
  tableName: 'api_keys',
  hooks: {
    beforeValidate: (instance: ApiKey) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.apiKey);
      }
    },
  },
})
export class ApiKey extends Model {
  @Column({
    type: DataType.STRING(32),
    unique: true,
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return User;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare userId: number;

  // CASCADE: an API key is meaningless without its owner, so deleting the user
  // removes their keys too (consistent with the project FK below). Without this
  // the default blocking constraint made `delete-user` 500 for any user that
  // owned a key (#611).
  @BelongsTo(
    () => {
      return User;
    },
    { onDelete: 'CASCADE' }
  )
  declare user: User;

  /**
   * The project this key is scoped to. Nullable: a key with a null projectId is
   * "unscoped" — it is not confined to any single project and its effective
   * permissions are the intersection of the owner's permissions and the key's
   * own attached policies (if any), across every project the owner can reach.
   */
  @ForeignKey(() => {
    return Project;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare projectId: number | null;

  @BelongsTo(
    () => {
      return Project;
    },
    { onDelete: 'CASCADE' }
  )
  declare project: Project;

  @Column({
    type: DataType.ARRAY(DataType.INTEGER),
    allowNull: false,
    defaultValue: [],
  })
  declare policyIds: number[];

  @Column({
    type: DataType.STRING,
    allowNull: false,
  })
  declare name: string;

  /**
   * First 8 characters of the raw API key. Stored in plaintext to allow
   * fast DB lookup before running bcrypt.compare against keyHash.
   */
  @Column({
    type: DataType.STRING(8),
    allowNull: false,
  })
  declare keyPrefix: string;

  /**
   * Bcrypt hash of the raw API key value (sk_{random}).
   * The raw key is shown once at creation and never stored in plaintext.
   */
  @Column({
    type: DataType.STRING,
    allowNull: false,
  })
  declare keyHash: string;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
