import { Column, DataType, Model, Table } from '@ttoss/postgresdb';

@Table({ tableName: 'documents' })
export class Document extends Model {
  @Column({
    type: DataType.UUID,
    primaryKey: true,
    defaultValue: DataType.UUIDV4,
  })
  declare id: string;

  @Column({ type: DataType.STRING })
  declare title?: string;

  @Column({ type: DataType.UUID })
  declare fileId: string;

  @Column({ type: DataType.STRING })
  declare embeddingModel?: string;

  @Column({ type: DataType.STRING })
  declare embeddingProvider?: string;

  @Column({ type: DataType.VECTOR(1536) })
  declare embedding?: number[];

  @Column({ type: DataType.TEXT })
  declare metadata?: string; // JSON string

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
