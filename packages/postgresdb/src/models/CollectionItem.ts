import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { Collection } from './Collection';

/**
 * One JSON document in a collection, addressed by its caller-chosen `key`.
 * It has no public id: the collection's id and the key name it.
 */
@Table({
  tableName: 'collection_items',
  indexes: [
    {
      name: 'collection_items_collection_id_key_unique',
      unique: true,
      fields: ['collection_id', 'key'],
    },
    {
      // Equality and `in` on `?data=` compile to containment (`@>`).
      name: 'collection_items_data_gin_idx',
      using: 'gin',
      fields: [{ name: 'data', operator: 'jsonb_path_ops' }],
    },
    {
      name: 'collection_items_tags_gin_idx',
      using: 'gin',
      fields: [{ name: 'tags', operator: 'jsonb_path_ops' }],
    },
  ],
})
export class CollectionItem extends Model {
  @ForeignKey(() => {
    return Collection;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare collectionId: number;

  @BelongsTo(
    () => {
      return Collection;
    },
    { onDelete: 'CASCADE' }
  )
  declare collection: Collection;

  @Column({ type: DataType.STRING(256), allowNull: false })
  declare key: string;

  @Column({ type: DataType.JSONB, allowNull: false })
  declare data: Record<string, unknown>;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare tags: Record<string, string> | null;

  /**
   * Claimed by a conditional `UPDATE … WHERE version = :expected`
   * (`lib/writePrecondition.ts`), so two writers racing on one item serialize.
   */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  declare version: number;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
