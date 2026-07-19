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
import { GuardrailVersion } from './GuardrailVersion';
import { Project } from './Project';

@Table({
  tableName: 'guardrails',
  hooks: {
    beforeValidate: (instance: Guardrail) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.guardrail);
      }
    },
  },
})
export class Guardrail extends Model {
  @Column({
    type: DataType.STRING(32),
    unique: true,
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

  @Column({ type: DataType.JSONB, allowNull: false })
  declare document: object;

  @Column({ type: DataType.STRING, allowNull: true })
  declare contextToolId: string | null;

  @Column({ type: DataType.STRING, allowNull: true, defaultValue: 'merge' })
  declare contextMode: string | null;

  @HasMany(() => {
    return GuardrailVersion;
  })
  declare versions: GuardrailVersion[];

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
