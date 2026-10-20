import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { PlaybookCase } from './PlaybookCase';

/**
 * A case bound, under one of its playbook's declared upstream names, to a case
 * of the upstream playbook. Fixed at create: the binding is never rewritten,
 * and many cases may share one upstream case.
 */
@Table({
  tableName: 'playbook_case_upstreams',
  indexes: [
    {
      name: 'playbook_case_upstreams_public_id_unique',
      unique: true,
      fields: ['public_id'],
    },
    {
      name: 'playbook_case_upstreams_case_id_name_unique',
      unique: true,
      fields: ['case_id', 'name'],
    },
    {
      name: 'playbook_case_upstreams_upstream_case_id_idx',
      fields: ['upstream_case_id'],
    },
  ],
  hooks: {
    beforeValidate: (instance: PlaybookCaseUpstream) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(
          PUBLIC_ID_PREFIXES.playbookCaseUpstream
        );
      }
    },
  },
})
export class PlaybookCaseUpstream extends Model {
  @Column({
    type: DataType.STRING(32),
    allowNull: false,
  })
  declare publicId: string;

  /** CASCADE: a binding is part of the dependent case. */
  @ForeignKey(() => {
    return PlaybookCase;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare caseId: number;

  @BelongsTo(
    () => {
      return PlaybookCase;
    },
    { foreignKey: 'caseId', as: 'case', onDelete: 'CASCADE' }
  )
  declare case: PlaybookCase;

  /** The upstream's name in the dependent playbook's definition. */
  @Column({ type: DataType.STRING(64), allowNull: false })
  declare name: string;

  /**
   * RESTRICT: a dependent case reads what its upstream case holds, so the
   * upstream case cannot be deleted from under it.
   */
  @ForeignKey(() => {
    return PlaybookCase;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare upstreamCaseId: number;

  @BelongsTo(
    () => {
      return PlaybookCase;
    },
    { foreignKey: 'upstreamCaseId', as: 'upstreamCase', onDelete: 'RESTRICT' }
  )
  declare upstreamCase: PlaybookCase;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;

  @Column({ type: DataType.DATE })
  declare updatedAt: Date;
}
