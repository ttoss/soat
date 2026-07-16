import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  Table,
} from '@ttoss/postgresdb';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '../utils/publicId';
import { PriceBook } from './PriceBook';
import { UsageEvent } from './UsageEvent';

/**
 * One priced dimension of a {@link UsageEvent}. Every meter type expresses its
 * usage as one or more components, so the model treats tokens and infra
 * identically: an `llm_tokens` event carries `input_tokens` / `cached_tokens` /
 * `output_tokens` (plus a non-billable `reasoning_tokens` detail), while a
 * `node_execution` event carries a single `node_second` component. `quantity`
 * is always expressed in `unit`, and `unitPrice` prices exactly that unit, so
 * `costUsd = quantity × unitPrice` holds uniformly. Append-only and immutable,
 * like its parent event.
 */
@Table({
  tableName: 'usage_components',
  timestamps: true,
  updatedAt: false,
  indexes: [{ fields: ['usage_event_id'] }],
  hooks: {
    beforeValidate: (instance: UsageComponent) => {
      if (!instance.publicId) {
        instance.publicId = generatePublicId(PUBLIC_ID_PREFIXES.usageComponent);
      }
    },
  },
})
export class UsageComponent extends Model {
  @Column({
    type: DataType.STRING(32),
    unique: true,
    allowNull: false,
  })
  declare publicId: string;

  @ForeignKey(() => {
    return UsageEvent;
  })
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare usageEventId: number;

  @BelongsTo(
    () => {
      return UsageEvent;
    },
    { onDelete: 'CASCADE' }
  )
  declare usageEvent: UsageEvent;

  // The measured dimension: `input_tokens` | `cached_tokens` | `output_tokens`
  // | `reasoning_tokens` | `node_second` | `request` | `gb_day` | …
  @Column({ type: DataType.STRING, allowNull: false })
  declare component: string;

  // The measured amount, expressed in `unit`. DECIMAL so non-integer measures
  // (GB-days, fractional seconds) are exact.
  @Column({ type: DataType.DECIMAL, allowNull: false })
  declare quantity: string;

  // Unit `quantity` is measured in: `token` | `node_second` | `request` |
  // `gb_day`. Must match the price row's unit for the cost to be well-defined.
  @Column({ type: DataType.STRING, allowNull: false })
  declare unit: string;

  // Whether this component contributes to cost. Non-billable components (e.g.
  // `reasoning_tokens`, which is a subset of `output_tokens` reported for
  // visibility only) carry a quantity but never a price, so they are excluded
  // from cost and from billable-token totals.
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
  declare billable: boolean;

  // USD per `unit`, frozen at write time from the price row effective then.
  // Null when no price row covered the component.
  @Column({ type: DataType.DECIMAL, allowNull: true })
  declare unitPrice: string | null;

  // `quantity × unitPrice`, frozen at write time. Null when unpriced.
  @Column({ type: DataType.DECIMAL, allowNull: true })
  declare costUsd: string | null;

  // The exact price-book row that produced `unitPrice`/`costUsd` — the price
  // version for an auditable receipt. SET NULL on delete: the cost is already
  // frozen, so a removed price row never changes the recorded cost.
  @ForeignKey(() => {
    return PriceBook;
  })
  @Column({ type: DataType.INTEGER, allowNull: true })
  declare priceId: number | null;

  @BelongsTo(
    () => {
      return PriceBook;
    },
    { onDelete: 'SET NULL' }
  )
  declare price: PriceBook | null;

  @Column({ type: DataType.DATE })
  declare createdAt: Date;
}
