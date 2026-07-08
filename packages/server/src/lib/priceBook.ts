import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';

const log = createDebug('soat:priceBook');

const PER_MILLION = 1_000_000;

export type PersistedPrice = {
  id: string;
  provider: string;
  model: string;
  inputPricePerM: number;
  outputPricePerM: number;
  cachedPricePerM: number | null;
  effectiveFrom: Date;
  createdAt: Date;
};

const mapPrice = (
  price: InstanceType<(typeof db)['PriceBook']>
): PersistedPrice => {
  return {
    id: price.publicId,
    provider: price.provider,
    model: price.model,
    inputPricePerM: Number(price.inputPricePerM),
    outputPricePerM: Number(price.outputPricePerM),
    cachedPricePerM:
      price.cachedPricePerM === null ? null : Number(price.cachedPricePerM),
    effectiveFrom: price.effectiveFrom,
    createdAt: price.createdAt,
  };
};

/**
 * Default price rows SOAT ships so cost is computed out of the box. Values are
 * USD per million tokens and are indicative — operators override them with
 * future-dated rows via `PUT /api/v1/usage/prices`. Seeded at a fixed past
 * `effectiveFrom` so they apply to every run until overridden.
 */
export const DEFAULT_PRICE_EFFECTIVE_FROM = new Date(
  '2020-01-01T00:00:00.000Z'
);

export const DEFAULT_PRICES: Array<{
  provider: string;
  model: string;
  inputPricePerM: number;
  outputPricePerM: number;
  cachedPricePerM: number | null;
}> = [
  {
    provider: 'openai',
    model: 'gpt-4o',
    inputPricePerM: 2.5,
    outputPricePerM: 10,
    cachedPricePerM: 1.25,
  },
  {
    provider: 'openai',
    model: 'gpt-4o-mini',
    inputPricePerM: 0.15,
    outputPricePerM: 0.6,
    cachedPricePerM: 0.075,
  },
  {
    provider: 'openai',
    model: 'o3-mini',
    inputPricePerM: 1.1,
    outputPricePerM: 4.4,
    cachedPricePerM: 0.55,
  },
  {
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-latest',
    inputPricePerM: 3,
    outputPricePerM: 15,
    cachedPricePerM: 0.3,
  },
  {
    provider: 'anthropic',
    model: 'claude-3-5-haiku-latest',
    inputPricePerM: 0.8,
    outputPricePerM: 4,
    cachedPricePerM: 0.08,
  },
  {
    provider: 'google',
    model: 'gemini-2.0-flash',
    inputPricePerM: 0.1,
    outputPricePerM: 0.4,
    cachedPricePerM: 0.025,
  },
];

/**
 * Idempotently inserts the shipped default price rows. Existing rows for a
 * `(provider, model, effectiveFrom)` key are left untouched, so re-running on
 * startup never overwrites operator changes.
 */
export const seedDefaultPrices = async (): Promise<void> => {
  for (const price of DEFAULT_PRICES) {
    await db.PriceBook.findOrCreate({
      where: {
        provider: price.provider,
        model: price.model,
        effectiveFrom: DEFAULT_PRICE_EFFECTIVE_FROM,
      },
      defaults: {
        provider: price.provider,
        model: price.model,
        inputPricePerM: String(price.inputPricePerM),
        outputPricePerM: String(price.outputPricePerM),
        cachedPricePerM:
          price.cachedPricePerM === null ? null : String(price.cachedPricePerM),
        effectiveFrom: DEFAULT_PRICE_EFFECTIVE_FROM,
      },
    });
  }
  log(
    'seedDefaultPrices: ensured %d default price rows',
    DEFAULT_PRICES.length
  );
};

/**
 * Returns the price row that applies to a call: the latest row for the
 * provider/model whose `effectiveFrom <= at`. Null when no row covers it (the
 * caller records tokens with `cost_usd = null`).
 */
export const getEffectivePrice = async (args: {
  provider: string;
  model: string;
  at: Date;
}): Promise<InstanceType<(typeof db)['PriceBook']> | null> => {
  return db.PriceBook.findOne({
    where: {
      provider: args.provider,
      model: args.model,
      effectiveFrom: { [Op.lte]: args.at },
    },
    order: [['effectiveFrom', 'DESC']],
  });
};

/**
 * Computes a call's cost in USD from a price row and its token counts. Cached
 * input tokens are billed at the cached rate (falling back to the input rate
 * when unset); reasoning tokens are already part of `outputTokens`. Returns a
 * fixed-precision string for the DECIMAL column, or null when there is no price.
 */
export const computeCostUsd = (args: {
  price: {
    inputPricePerM: string;
    outputPricePerM: string;
    cachedPricePerM: string | null;
  } | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}): string | null => {
  if (!args.price) return null;
  const inputRate = Number(args.price.inputPricePerM);
  const outputRate = Number(args.price.outputPricePerM);
  const cachedRate =
    args.price.cachedPricePerM === null
      ? inputRate
      : Number(args.price.cachedPricePerM);
  const uncachedInput = Math.max(0, args.inputTokens - args.cachedTokens);
  const cost =
    (uncachedInput * inputRate +
      args.cachedTokens * cachedRate +
      args.outputTokens * outputRate) /
    PER_MILLION;
  return cost.toFixed(6);
};

export const listPrices = async (): Promise<{ prices: PersistedPrice[] }> => {
  const rows = await db.PriceBook.findAll({
    order: [
      ['provider', 'ASC'],
      ['model', 'ASC'],
      ['effectiveFrom', 'DESC'],
    ],
  });
  return { prices: rows.map(mapPrice) };
};

type PriceInput = {
  provider: string;
  model: string;
  inputPricePerM: number;
  outputPricePerM: number;
  cachedPricePerM?: number | null;
  effectiveFrom: string;
};

const upsertPriceRow = async (args: {
  price: PriceInput;
  now: Date;
}): Promise<InstanceType<(typeof db)['PriceBook']>> => {
  const effectiveFrom = new Date(args.price.effectiveFrom);
  // Past-effective prices are immutable: a recorded cost must always be
  // explainable by the row that produced it, so corrections ship as new
  // future-dated rows rather than edits to historical prices.
  if (Number.isNaN(effectiveFrom.getTime()) || effectiveFrom <= args.now) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `effective_from must be a valid future timestamp (got '${args.price.effectiveFrom}').`
    );
  }

  const values = {
    provider: args.price.provider,
    model: args.price.model,
    inputPricePerM: String(args.price.inputPricePerM),
    outputPricePerM: String(args.price.outputPricePerM),
    cachedPricePerM:
      args.price.cachedPricePerM === undefined ||
      args.price.cachedPricePerM === null
        ? null
        : String(args.price.cachedPricePerM),
    effectiveFrom,
  };

  const [row, created] = await db.PriceBook.findOrCreate({
    where: {
      provider: values.provider,
      model: values.model,
      effectiveFrom: values.effectiveFrom,
    },
    defaults: values,
  });

  if (!created) {
    await row.update({
      inputPricePerM: values.inputPricePerM,
      outputPricePerM: values.outputPricePerM,
      cachedPricePerM: values.cachedPricePerM,
    });
  }

  return row;
};

export const upsertPrices = async (args: {
  prices: PriceInput[];
}): Promise<{ prices: PersistedPrice[] }> => {
  const now = new Date();
  const rows: InstanceType<(typeof db)['PriceBook']>[] = [];
  for (const price of args.prices) {
    rows.push(await upsertPriceRow({ price, now }));
  }
  return { prices: rows.map(mapPrice) };
};
