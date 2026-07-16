import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { DEFAULT_METER_TYPE, validatePriceShape } from './priceCompute';

export {
  computeCostUsd,
  DEFAULT_METER_TYPE,
  validatePriceShape,
} from './priceCompute';

const log = createDebug('soat:priceBook');

export type PersistedPrice = {
  id: string;
  aiProviderId: string | null;
  projectId: string | null;
  meterType: string;
  provider: string;
  model: string;
  inputPricePerM: number | null;
  outputPricePerM: number | null;
  cachedPricePerM: number | null;
  unitPrice: number | null;
  unit: string | null;
  effectiveFrom: Date;
  createdAt: Date;
};

const decimalOrNull = (value: string | null): number | null => {
  return value === null ? null : Number(value);
};

const mapPrice = (
  price: InstanceType<(typeof db)['PriceBook']> & {
    aiProvider?: InstanceType<(typeof db)['AiProvider']> | null;
    project?: InstanceType<(typeof db)['Project']> | null;
  }
): PersistedPrice => {
  return {
    id: price.publicId,
    aiProviderId: price.aiProvider?.publicId ?? null,
    projectId: price.project?.publicId ?? null,
    meterType: price.meterType,
    provider: price.provider,
    model: price.model,
    inputPricePerM: decimalOrNull(price.inputPricePerM),
    outputPricePerM: decimalOrNull(price.outputPricePerM),
    cachedPricePerM: decimalOrNull(price.cachedPricePerM),
    unitPrice: decimalOrNull(price.unitPrice),
    unit: price.unit,
    effectiveFrom: price.effectiveFrom,
    createdAt: price.createdAt,
  };
};

/**
 * Returns the price row that applies to a call, resolving most-specific first:
 * a per-provider override (`aiProviderId` set) → a project + provider-slug
 * price (`projectId` set, `aiProviderId` null) → the global default (both
 * null). Within each scope the latest row with `effectiveFrom <= at` applies.
 * Null when no row covers it (the caller records tokens with `cost_usd = null`).
 */
export const getEffectivePrice = async (args: {
  provider: string;
  model: string;
  aiProviderId: number | null;
  projectId: number | null;
  at: Date;
}): Promise<InstanceType<(typeof db)['PriceBook']> | null> => {
  // Tier 1 — a specific AI provider instance.
  if (args.aiProviderId !== null) {
    const override = await db.PriceBook.findOne({
      where: {
        aiProviderId: args.aiProviderId,
        provider: args.provider,
        model: args.model,
        effectiveFrom: { [Op.lte]: args.at },
      },
      order: [['effectiveFrom', 'DESC']],
    });
    if (override) return override;
  }

  // Tier 2 — the project's rate for this provider slug.
  if (args.projectId !== null) {
    const projectPrice = await db.PriceBook.findOne({
      where: {
        aiProviderId: null,
        projectId: args.projectId,
        provider: args.provider,
        model: args.model,
        effectiveFrom: { [Op.lte]: args.at },
      },
      order: [['effectiveFrom', 'DESC']],
    });
    if (projectPrice) return projectPrice;
  }

  // Tier 3 — the global default.
  return db.PriceBook.findOne({
    where: {
      aiProviderId: null,
      projectId: null,
      provider: args.provider,
      model: args.model,
      effectiveFrom: { [Op.lte]: args.at },
    },
    order: [['effectiveFrom', 'DESC']],
  });
};

// Lists the global default prices only. Per-provider overrides and project +
// provider-slug prices are not exposed here — they're read through their own
// project-scoped endpoints, so one project never sees another's rates.
export const listPrices = async (): Promise<{ prices: PersistedPrice[] }> => {
  const rows = await db.PriceBook.findAll({
    where: { aiProviderId: null, projectId: null },
    order: [
      ['provider', 'ASC'],
      ['model', 'ASC'],
      ['effectiveFrom', 'DESC'],
    ],
  });
  return { prices: rows.map(mapPrice) };
};

type PriceInput = {
  aiProviderId?: string | null;
  meterType?: string;
  provider: string;
  model: string;
  inputPricePerM?: number | null;
  outputPricePerM?: number | null;
  cachedPricePerM?: number | null;
  unitPrice?: number | null;
  unit?: string | null;
  effectiveFrom: string;
};

// Resolves an optional AI provider public ID to its internal id. Null (a global
// default row) passes through; an unknown provider is a bad request.
const resolveAiProviderId = async (
  publicId: string | null | undefined
): Promise<number | null> => {
  if (!publicId) return null;
  const provider = await db.AiProvider.findOne({ where: { publicId } });
  if (!provider) {
    throw new DomainError(
      'AI_PROVIDER_NOT_FOUND',
      `AI provider '${publicId}' not found.`
    );
  }
  return provider.id as number;
};

// Core price-row write shared by the admin global path and the project-scoped
// per-provider path. Takes an already-resolved numeric `aiProviderId`
// (null = global default). Past-effective prices are immutable: a recorded cost
// must always be explainable by the row that produced it, so corrections ship
// as new future-dated rows rather than edits to historical prices.
const toDecimalString = (value: number | null | undefined): string | null => {
  return value === undefined || value === null ? null : String(value);
};

// Throws VALIDATION_FAILED when the row's rate columns don't match its type.
const assertPriceShape = (
  meterType: string,
  args: {
    inputPricePerM?: number | null;
    outputPricePerM?: number | null;
    cachedPricePerM?: number | null;
    unitPrice?: number | null;
    unit?: string | null;
  }
): void => {
  const shapeError = validatePriceShape({ ...args, meterType });
  if (shapeError) {
    throw new DomainError('VALIDATION_FAILED', shapeError);
  }
};

// Past-effective prices are immutable, so only a valid future timestamp is
// accepted; anything else is a bad request.
const parseFutureEffectiveFrom = (value: string, now: Date): Date => {
  const effectiveFrom = new Date(value);
  if (Number.isNaN(effectiveFrom.getTime()) || effectiveFrom <= now) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `effective_from must be a valid future timestamp (got '${value}').`
    );
  }
  return effectiveFrom;
};

const writePriceRow = async (args: {
  aiProviderId: number | null;
  projectId: number | null;
  meterType?: string;
  provider: string;
  model: string;
  inputPricePerM?: number | null;
  outputPricePerM?: number | null;
  cachedPricePerM?: number | null;
  unitPrice?: number | null;
  unit?: string | null;
  effectiveFrom: string;
  now: Date;
}): Promise<number> => {
  const meterType = args.meterType ?? DEFAULT_METER_TYPE;
  assertPriceShape(meterType, args);
  const effectiveFrom = parseFutureEffectiveFrom(args.effectiveFrom, args.now);

  const values = {
    aiProviderId: args.aiProviderId,
    projectId: args.projectId,
    meterType,
    provider: args.provider,
    model: args.model,
    inputPricePerM: toDecimalString(args.inputPricePerM),
    outputPricePerM: toDecimalString(args.outputPricePerM),
    cachedPricePerM: toDecimalString(args.cachedPricePerM),
    unitPrice: toDecimalString(args.unitPrice),
    unit: args.unit ?? null,
    effectiveFrom,
  };

  const [row, created] = await db.PriceBook.findOrCreate({
    where: {
      aiProviderId: args.aiProviderId,
      projectId: args.projectId,
      provider: values.provider,
      model: values.model,
      effectiveFrom: values.effectiveFrom,
    },
    defaults: values,
  });

  if (!created) {
    await row.update({
      meterType: values.meterType,
      inputPricePerM: values.inputPricePerM,
      outputPricePerM: values.outputPricePerM,
      cachedPricePerM: values.cachedPricePerM,
      unitPrice: values.unitPrice,
      unit: values.unit,
    });
  }

  return row.id as number;
};

const upsertPriceRow = async (args: {
  price: PriceInput;
  now: Date;
}): Promise<number> => {
  const aiProviderId = await resolveAiProviderId(args.price.aiProviderId);
  return writePriceRow({
    aiProviderId,
    projectId: null,
    meterType: args.price.meterType,
    provider: args.price.provider,
    model: args.price.model,
    inputPricePerM: args.price.inputPricePerM,
    outputPricePerM: args.price.outputPricePerM,
    cachedPricePerM: args.price.cachedPricePerM,
    unitPrice: args.price.unitPrice,
    unit: args.price.unit,
    effectiveFrom: args.price.effectiveFrom,
    now: args.now,
  });
};

export const upsertPrices = async (args: {
  prices: PriceInput[];
}): Promise<{ prices: PersistedPrice[] }> => {
  const now = new Date();
  const ids: number[] = [];
  for (const price of args.prices) {
    ids.push(await upsertPriceRow({ price, now }));
  }
  const rows = await db.PriceBook.findAll({
    where: { id: ids },
    include: [{ model: db.AiProvider, as: 'aiProvider' }],
  });
  return { prices: rows.map(mapPrice) };
};

export type ProviderPriceInput = {
  model: string;
  inputPricePerM: number;
  outputPricePerM: number;
  cachedPricePerM?: number | null;
  effectiveFrom: string;
};

// Resolves an AI provider public ID to its internal id and provider slug, or
// throws when it does not exist.
const getProviderForPricing = async (
  aiProviderId: string
): Promise<{ id: number; provider: string }> => {
  const provider = await db.AiProvider.findOne({
    where: { publicId: aiProviderId },
  });
  if (!provider) {
    throw new DomainError(
      'AI_PROVIDER_NOT_FOUND',
      `AI provider '${aiProviderId}' not found.`
    );
  }
  return { id: provider.id as number, provider: provider.provider };
};

/**
 * Lists the per-provider price overrides for one AI provider instance. Unlike
 * the global price book (`listPrices`), overrides ARE returned here — the caller
 * is scoped to the provider's own project, so there is no cross-tenant leak.
 */
export const listProviderPrices = async (args: {
  aiProviderId: string;
}): Promise<{ prices: PersistedPrice[] }> => {
  log('listProviderPrices: aiProviderId=%s', args.aiProviderId);
  const { id } = await getProviderForPricing(args.aiProviderId);
  const rows = await db.PriceBook.findAll({
    where: { aiProviderId: id },
    include: [{ model: db.AiProvider, as: 'aiProvider' }],
    order: [
      ['model', 'ASC'],
      ['effectiveFrom', 'DESC'],
    ],
  });
  return { prices: rows.map(mapPrice) };
};

/**
 * Upserts per-provider price overrides for one AI provider instance. The
 * override's `provider` slug is taken from the AI provider itself — an override
 * only wins at cost time when its slug equals the provider's — so callers supply
 * just the model, rates, and `effectiveFrom`. Future-date-only, like the global
 * path: past-effective prices are immutable.
 */
export const upsertProviderPrices = async (args: {
  aiProviderId: string;
  prices: ProviderPriceInput[];
}): Promise<{ prices: PersistedPrice[] }> => {
  log(
    'upsertProviderPrices: aiProviderId=%s count=%d',
    args.aiProviderId,
    args.prices.length
  );
  const { id, provider } = await getProviderForPricing(args.aiProviderId);
  const now = new Date();
  const ids: number[] = [];
  for (const price of args.prices) {
    ids.push(
      await writePriceRow({
        aiProviderId: id,
        projectId: null,
        provider,
        model: price.model,
        inputPricePerM: price.inputPricePerM,
        outputPricePerM: price.outputPricePerM,
        cachedPricePerM: price.cachedPricePerM,
        effectiveFrom: price.effectiveFrom,
        now,
      })
    );
  }
  const rows = await db.PriceBook.findAll({
    where: { id: ids },
    include: [{ model: db.AiProvider, as: 'aiProvider' }],
  });
  return { prices: rows.map(mapPrice) };
};

// Resolves a project public ID to its internal id, or throws when missing.
const getProjectForPricing = async (projectId: string): Promise<number> => {
  const project = await db.Project.findOne({ where: { publicId: projectId } });
  if (!project) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Project '${projectId}' not found.`
    );
  }
  return project.id as number;
};

export type ProjectPriceInput = {
  provider: string;
  model: string;
  inputPricePerM: number;
  outputPricePerM: number;
  cachedPricePerM?: number | null;
  effectiveFrom: string;
};

/**
 * Lists the project + provider-slug price rows for one project — the middle
 * pricing tier that covers every one of the project's instances of a given
 * provider slug. Scoped to the project, so no cross-tenant leak.
 */
export const listProjectPrices = async (args: {
  projectId: string;
}): Promise<{ prices: PersistedPrice[] }> => {
  log('listProjectPrices: projectId=%s', args.projectId);
  const id = await getProjectForPricing(args.projectId);
  const rows = await db.PriceBook.findAll({
    where: { projectId: id, aiProviderId: null },
    include: [{ model: db.Project, as: 'project' }],
    order: [
      ['provider', 'ASC'],
      ['model', 'ASC'],
      ['effectiveFrom', 'DESC'],
    ],
  });
  return { prices: rows.map(mapPrice) };
};

/**
 * Upserts project + provider-slug price rows, keyed on
 * `(project, provider, model, effectiveFrom)`. Unlike the per-provider path the
 * caller supplies `provider` explicitly — the price covers all of the project's
 * instances of that slug, not one instance. Future-date-only.
 */
export const upsertProjectPrices = async (args: {
  projectId: string;
  prices: ProjectPriceInput[];
}): Promise<{ prices: PersistedPrice[] }> => {
  log(
    'upsertProjectPrices: projectId=%s count=%d',
    args.projectId,
    args.prices.length
  );
  const id = await getProjectForPricing(args.projectId);
  const now = new Date();
  const ids: number[] = [];
  for (const price of args.prices) {
    ids.push(
      await writePriceRow({
        aiProviderId: null,
        projectId: id,
        provider: price.provider,
        model: price.model,
        inputPricePerM: price.inputPricePerM,
        outputPricePerM: price.outputPricePerM,
        cachedPricePerM: price.cachedPricePerM,
        effectiveFrom: price.effectiveFrom,
        now,
      })
    );
  }
  const rows = await db.PriceBook.findAll({
    where: { id: ids },
    include: [{ model: db.Project, as: 'project' }],
  });
  return { prices: rows.map(mapPrice) };
};
