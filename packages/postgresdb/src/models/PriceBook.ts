import { Column, DataType, Model, Table } from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';

/**
 * Versioned, global price data used to compute a `UsageMeter`'s `cost_usd` at
 * write time. Prices are keyed by `(provider, model, effectiveFrom)`; for a
 * given provider/model the row with the latest `effectiveFrom <= now()` applies.
 * New future-dated rows change the price deterministically without mutating the
 * costs already recorded from earlier rows.
 */
@Table({
  tableName: 'price_books',
  timestamps: true,
  updatedAt: false,
  // The unique composite also serves effective-price lookups by its
  // (provider, model) leftmost prefix, so no separate index is needed.
  indexes: [{ unique: true, fields: ['provider', 'model', 'effective_from'] }],
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
