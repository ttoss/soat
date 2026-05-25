import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Formation } from './Formation';

@Table({
  tableName: 'formation_operations',
  hooks: {
    beforeValidate: (instance: FormationOperation) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(
          PUBLIC_ID_PREFIXES.formationOperation
        );
      }
    },
  },
})
export class FormationOperation extends Model {
  @Column({
    type: DataType.STRING(32),
    unique: true,
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return Formation;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare formationId: number | null;

  @BelongsTo(
    () => {
      return Formation;
    },
    { onDelete: 'CASCADE' }
  )
  declare formation: Formation | null;

  @Column({ type: DataType.STRING, allowNull: false })
  declare operationType: string;

  @Column({ type: DataType.STRING, allowNull: false, defaultValue: 'pending' })
  declare status: string;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare events: object[] | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare plan: object | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare error: object | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
