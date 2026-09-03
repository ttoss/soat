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
  indexes: [
    {
      name: 'formation_resources_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    {
      name: 'formation_resources_formation_id_logical_id_unique',
      unique: true,
      fields: ['formation_id', 'logical_id'],
    },
  ],
})
export class FormationResource extends Model {
  @Column({
    type: DataType.STRING(32),
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

  @Column({ type: DataType.STRING, allowNull: false, defaultValue: 'delete' })
  declare deletionPolicy: string;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare lastAppliedProperties: Record<string, unknown> | null;

  /**
   * Physical resources this logical id superseded by replacement and could not
   * delete. Kept so a later operation retries the disposal instead of leaving
   * the resource live and owned by nothing (#1193) — the ledger has already
   * moved to the replacement, so nothing else would ever name it again.
   */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare pendingCleanupPhysicalResourceIds: string[] | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
