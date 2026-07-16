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
 * Versioned unit price for a single billable **component** of a SKU. Cost is
 * uniform across meter types — `costUsd = quantity × unitPrice` — so a price
 * row prices one `(provider, model, component)` at a time: e.g. `openai` /
 * `gpt-4o` / `output_tokens`, or `soat` / `node-second` / `node_second`.
 *
 * Three scopes live in one table, resolved most-specific first: a
 * **per-provider override** (`aiProviderId` set) for one AI provider instance;
 * a **project + provider-slug** price (`projectId` set, `aiProviderId` null);
 * and a **global default** (both null). Within each scope the latest
 * `effectiveFrom <= now()` applies. New future-dated rows change the price
 * deterministically without mutating costs already frozen onto components.
 */
@Table({
  tableName: 'price_books',
  timestamps: true,
  updatedAt: false,
  indexes: [
    {
      // Explicit name: the auto-generated name for this many columns exceeds
      // Postgres's 63-char identifier limit, and a truncated catalog name no
      // longer matches the recomputed expected name on the next
      // `sync({ alter: true })`, crashing boot with 42P07.
      name: 'price_books_scope_sku_component_effective_uk',
      unique: true,
      fields: [
        'ai_provider_id',
        'project_id',
        'provider',
        'model',
        'component',
        'effective_from',
      ],
    },
    // Serves the global-default, project+slug, and per-provider lookups.
    { fields: ['provider', 'model', 'component', 'effective_from'] },
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

  // Null = global default. Set = override for a specific AI provider instance.
  // Deleting the provider drops its overrides; frozen component costs are safe.
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

  // Null unless this is a project + provider-slug price. Deleting the project
  // drops its price rows; frozen component costs are safe.
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

  // Meter type this SKU belongs to (`llm_tokens`, `node_execution`, …).
  @Column({ type: DataType.STRING, allowNull: false })
  declare meterType: string;

  // SKU vendor slug (`openai`, or `soat` for platform SKUs).
  @Column({ type: DataType.STRING, allowNull: false })
  declare provider: string;

  // SKU identifier: the model id for LLM SKUs, the platform unit otherwise.
  @Column({ type: DataType.STRING, allowNull: false })
  declare model: string;

  // The component this row prices (`input_tokens`, `output_tokens`,
  // `cached_tokens`, `node_second`, …).
  @Column({ type: DataType.STRING, allowNull: false })
  declare component: string;

  // Unit `unitPrice` is denominated in (`token`, `node_second`, …). Must match
  // the metered component's unit.
  @Column({ type: DataType.STRING, allowNull: false })
  declare unit: string;

  // USD per `unit`.
  @Column({ type: DataType.DECIMAL, allowNull: false })
  declare unitPrice: string;

  // The row with the latest effectiveFrom <= now() prices a call.
  @Column({ type: DataType.DATE, allowNull: false })
  declare effectiveFrom: Date;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;
}
