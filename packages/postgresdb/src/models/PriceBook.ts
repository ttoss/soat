import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { AiProvider } from './AiProvider';
import { Project } from './Project';

/**
 * Versioned price data used to compute a `UsageMeter`'s `cost_usd` at write
 * time. Three scopes live in one table, resolved most-specific first:
 * a **per-provider override** (`aiProviderId` set) for one AI provider
 * instance; a **project + provider-slug** price (`projectId` set,
 * `aiProviderId` null) covering all of a project's instances of a slug; and a
 * **global default** (both null). Cost lookup prefers instance → project+slug →
 * global; within each scope the latest `effectiveFrom <= now()` applies. New
 * future-dated rows change the price deterministically without mutating costs
 * already recorded from earlier rows.
 */
@Table({
  tableName: 'price_books',
  timestamps: true,
  updatedAt: false,
  indexes: [
    {
      // Explicit name: the auto-generated name for this many columns is 67
      // chars, but Postgres truncates identifiers to 63. On the next
      // `sync({ alter: true })`, the truncated catalog name no longer matches
      // the recomputed (untruncated) expected name, so Sequelize tries to
      // recreate the index under the same truncated name and Postgres raises
      // 42P07 "relation already exists" — crashing every boot after the first.
      name: 'price_books_provider_model_effective_uk',
      unique: true,
      fields: [
        'ai_provider_id',
        'project_id',
        'provider',
        'model',
        'effective_from',
      ],
    },
    // Serves the global-default, project+slug, and per-provider lookups.
    { fields: ['provider', 'model', 'effective_from'] },
  ],
  hooks: {
    beforeValidate: (instance: PriceBook) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.price);
      }
    },
  },
})
export class PriceBook extends Model {
  @Column({
    type: DataType.STRING(32),
    unique: true,
    allowNull: false,
  })
  declare publicId: string;

  // Null = global default. Set = override for a specific AI provider instance
  // (e.g. an enterprise-negotiated rate or a gateway with markup). Deleting the
  // provider drops its overrides; recorded meter costs are already frozen.
  @ForeignKey(() => {
    return AiProvider;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare aiProviderId: number | null;

  @BelongsTo(
    () => {
      return AiProvider;
    },
    { onDelete: 'CASCADE' }
  )
  declare aiProvider: AiProvider | null;

  // Null unless this is a project + provider-slug price. Set = a project-scoped
  // rate covering every one of that project's instances of `provider`. Deleting
  // the project drops its price rows; recorded meter costs are already frozen.
  @ForeignKey(() => {
    return Project;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare projectId: number | null;

  @BelongsTo(
    () => {
      return Project;
    },
    { onDelete: 'CASCADE' }
  )
  declare project: Project | null;

  @Column({ type: DataType.STRING, allowNull: false })
  declare provider: string;

  @Column({ type: DataType.STRING, allowNull: false })
  declare model: string;

  // USD per one million input (prompt) tokens.
  @Column({ type: DataType.DECIMAL, allowNull: false })
  declare inputPricePerM: string;

  // USD per one million output (completion) tokens. Reasoning tokens are part
  // of the output count and are billed at this rate.
  @Column({ type: DataType.DECIMAL, allowNull: false })
  declare outputPricePerM: string;

  // USD per one million cached input tokens read. Null falls back to the input
  // price (i.e. no cache discount).
  @Column({ type: DataType.DECIMAL, allowNull: true })
  declare cachedPricePerM: string | null;

  // The row with the latest effectiveFrom <= now() prices a call.
  @Column({ type: DataType.DATE, allowNull: false })
  declare effectiveFrom: Date;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;
}
