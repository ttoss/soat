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
import { PlaybookCase } from './PlaybookCase';
import { PlaybookVersion } from './PlaybookVersion';
import { Project } from './Project';

/**
 * A versioned template of nodes whose inputs read people or earlier nodes. A
 * `PlaybookCase` fills one version for one subject.
 *
 * `version` counts the definition only: every write that changes `definition`
 * archives a `PlaybookVersion`, and a case pins the version it was created on.
 * Name and description are metadata and leave it untouched.
 */
@Table({
  tableName: 'playbooks',
  indexes: [
    {
      name: 'playbooks_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    {
      name: 'playbooks_project_id_name_unique',
      unique: true,
      fields: ['project_id', 'name'],
    },
  ],
  hooks: {
    beforeValidate: (instance: Playbook) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.playbook);
      }
    },
  },
})
export class Playbook extends Model {
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

  @Column({ type: DataType.STRING, allowNull: false })
  declare name: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare description: string | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  declare version: number;

  /**
   * `{ nodes: [...] }`, in the wire shape. `JSON`, not `JSONB`: `JSONB`
   * reorders object keys, so a node would read back in another field order
   * than it was written.
   */
  @Column({ type: DataType.JSON, allowNull: false })
  declare definition: object;

  @HasMany(() => {
    return PlaybookVersion;
  })
  declare versions: PlaybookVersion[];

  @HasMany(() => {
    return PlaybookCase;
  })
  declare cases: PlaybookCase[];

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
