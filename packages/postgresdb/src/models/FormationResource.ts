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
  tableName: 'formation_resources',
  hooks: {
    beforeValidate: (instance: FormationResource) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(
          PUBLIC_ID_PREFIXES.formationResource
        );
      }
    },
  },
  indexes: [{ unique: true, fields: ['formation_id', 'logical_id'] }],
})
export class FormationResource extends Model {
  @Column({
    type: DataType.STRING(32),
    unique: true,
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return Formation;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare formationId: number;

  @BelongsTo(
    () => {
      return Formation;
    },
    { onDelete: 'CASCADE' }
  )
  declare formation: Formation;

  @Column({ type: DataType.STRING, allowNull: false })
  declare logicalId: string;

  @Column({ type: DataType.STRING, allowNull: false })
  declare resourceType: string;

  @Column({ type: DataType.STRING, allowNull: true })
  declare physicalResourceId: string | null;

  @Column({ type: DataType.STRING, allowNull: false, defaultValue: 'pending' })
  declare status: string;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare lastAppliedProperties: Record<string, unknown> | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
