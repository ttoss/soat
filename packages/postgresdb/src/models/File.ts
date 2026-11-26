import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Op,
  Sequelize,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Project } from './Project';

/**
 * A file past its `expires_at` is gone to every read before the sweep deletes
 * it. A find hook rather than a default scope: a scope's `where` would turn
 * every `include` of a file into an inner join. Only the sweep and project
 * teardown read expired rows, with `hooks: false`.
 */
const UNEXPIRED_FILE_WHERE = {
  expiresAt: {
    [Op.or]: [{ [Op.is]: null }, { [Op.gt]: Sequelize.literal('NOW()') }],
  },
};

@Table({
  tableName: 'files',
  indexes: [
    {
      name: 'files_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    {
      // Containment (`@>`) is the only way a tag bag is matched, by the
      // `?tags=` filter, knowledge search and a `iam:ResourceTag/<key>`
      // condition alike. `jsonb_path_ops` indexes whole key/value paths,
      // which is exactly what that match asks about.
      name: 'files_tags_gin_idx',
      using: 'gin',
      fields: [{ name: 'tags', operator: 'jsonb_path_ops' }],
    },
    {
      name: 'files_expires_at_idx',
      fields: ['expires_at'],
    },
    {
      name: 'files_consumed_by_generation_id_idx',
      fields: ['consumed_by_generation_id'],
    },
    {
      name: 'files_project_id_path_unique',
      unique: true,
      fields: ['project_id', 'path'],
    },
  ],
  hooks: {
    beforeValidate: (instance: File) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.file);
      }
    },
    beforeFind: (options: { where?: unknown }) => {
      options.where = options.where
        ? { [Op.and]: [options.where, UNEXPIRED_FILE_WHERE] }
        : UNEXPIRED_FILE_WHERE;
    },
  },
})
export class File extends Model {
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

  @Column({ type: DataType.STRING(1024), allowNull: true })
  declare path: string | null;

  @Column({ type: DataType.STRING })
  declare filename?: string;

  @Column({ type: DataType.STRING })
  declare contentType?: string;

  @Column({ type: DataType.INTEGER })
  declare size?: number;

  @Column({ type: DataType.ENUM('local', 's3', 'gcs') })
  declare storageType: 'local' | 's3' | 'gcs';

  @Column({ type: DataType.STRING })
  declare storagePath: string;

  @Column({
    type: DataType.JSON,
    allowNull: true,
  })
  declare metadata: Record<string, unknown> | null;

  @Column({
    type: DataType.JSONB,
    allowNull: true,
    defaultValue: {},
  })
  declare tags: Record<string, string> | null;

  /** When the file is deleted; null never. */
  @Column({ type: DataType.DATE, allowNull: true })
  declare expiresAt: Date | null;

  /** `generation`: deleted when the generation that claims it settles. */
  @Column({ type: DataType.STRING(16), allowNull: true })
  declare deleteAfter: 'generation' | null;

  /** Public id of the generation that claimed a `deleteAfter` file. */
  @Column({ type: DataType.STRING(32), allowNull: true })
  declare consumedByGenerationId: string | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
