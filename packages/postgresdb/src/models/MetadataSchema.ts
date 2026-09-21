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

/**
 * What a resource's `metadata` must satisfy in a project.
 *
 * A row per declaration rather than a list on the project: two operators
 * governing different corners of a corpus write independently, where a single
 * column would make every change a whole-list replace and the second writer
 * would silently drop the first one's rule.
 */
@Table({
  tableName: 'metadata_schemas',
  hooks: {
    beforeValidate: (instance: MetadataSchema) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.metadataSchema);
      }
    },
  },
  indexes: [
    {
      name: 'metadata_schemas_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    {
      // One selector has one schema: the uniqueness a declaration's identity
      // rests on, enforced where two concurrent writers both see it.
      name: 'metadata_schemas_project_id_resource_type_selector_unique',
      unique: true,
      fields: ['project_id', 'resource_type', 'selector'],
    },
    {
      // The gate's read: every declaration of one type in one project.
      name: 'metadata_schemas_project_id_resource_type_idx',
      fields: ['project_id', 'resource_type'],
    },
  ],
})
export class MetadataSchema extends Model {
  @Column({ type: DataType.STRING(32), allowNull: false })
  declare publicId: string;

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

  /** The resource this declaration governs. */
  @Column({ type: DataType.STRING(32), allowNull: false })
  declare resourceType: string;

  /**
   * How the type is addressed. A document's is the normalized path prefix it
   * is filed under; another type names its own, which is why this is one
   * column rather than one per type's spelling.
   */
  @Column({ type: DataType.STRING, allowNull: false })
  declare selector: string;

  /**
   * A JSON Schema, stored as written: its keywords are its own vocabulary and
   * are never case-converted. Every stored value compiles, because one that
   * does not is refused when it is declared.
   */
  @Column({ type: DataType.JSONB, allowNull: false })
  declare schema: Record<string, unknown>;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
