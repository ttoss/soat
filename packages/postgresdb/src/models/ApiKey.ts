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
  indexes: [
    {
      name: 'api_keys_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    {
      name: 'api_keys_key_hash_sha256_unique',
      unique: true,
      fields: ['key_hash_sha256'],
    },
  ],
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
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return User;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare userId: number;

  // CASCADE: without it the default blocking constraint made `delete-user` 500
  // for any user that owned a key.
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
   * First 8 characters of the raw API key, in plaintext. Returned as
   * `key_prefix` so a caller can tell keys apart, and the lookup column for a
   * row with no `keyHashSha256` yet.
   */
  @Column({
    type: DataType.STRING(8),
    allowNull: false,
  })
  declare keyPrefix: string;

  /**
   * Bcrypt hash of the raw key, verified by prefix lookup on a row with no
   * `keyHashSha256`; that verification writes the SHA-256. Keys minted by
   * `createApiKey` carry none.
   */
  @Column({
    type: DataType.STRING,
    allowNull: true,
  })
  declare keyHash: string | null;

  /**
   * Hex SHA-256 of the raw key (`sk_{random}`), the column a bearer is looked
   * up by. A fast hash is sound because the key carries 256 random bits: no
   * hash speed makes it guessable. The raw key is never stored.
   */
  @Column({
    type: DataType.STRING(64),
    allowNull: true,
  })
  declare keyHashSha256: string | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
