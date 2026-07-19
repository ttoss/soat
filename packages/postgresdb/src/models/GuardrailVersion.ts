import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { Guardrail } from './Guardrail';

/**
 * Immutable archive of a guardrail's `document` at a given version. A new row
 * is written on every document write; existing rows are never mutated, so the
 * audit chain (approval items, activity entries) can reference the exact
 * document that governed them. There is no `updatedAt`.
 */
@Table({
  tableName: 'guardrail_versions',
  updatedAt: false,
  hooks: {
    beforeValidate: (instance: GuardrailVersion) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(
          PUBLIC_ID_PREFIXES.guardrailVersion
        );
      }
    },
  },
})
export class GuardrailVersion extends Model {
  @Column({
    type: DataType.STRING(32),
    unique: true,
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return Guardrail;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare guardrailId: number;

  @BelongsTo(() => {
    return Guardrail;
  })
  declare guardrail: Guardrail;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare version: number;

  @Column({ type: DataType.JSONB, allowNull: false })
  declare document: object;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;
}
