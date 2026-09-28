import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { createEffectiveFromResolver } from './priceBookEffectiveFrom';
import { DEFAULT_METER_TYPE, validatePriceInput } from './priceCompute';
import { assertToolPriceFields, resolvePriceToolId } from './usageToolPricing';

export { DEFAULT_METER_TYPE } from './priceCompute';

const log = createDebug('soat:priceBook');

export type PersistedPrice = {
  id: string;
  ai_provider_id: string | null;
  project_id: string | null;
  tool_id: string | null;
  meter_type: string;
  provider: string;
  model: string;
  component: string;
  unit: string;
  quantity: object | null;
  unit_price: number;
  effective_from: Date;
  created_at: Date;
};

export const mapPrice = (
  price: InstanceType<(typeof db)['PriceBook']> & {
    aiProvider?: InstanceType<(typeof db)['AiProvider']> | null;
    project?: InstanceType<(typeof db)['Project']> | null;
    tool?: InstanceType<(typeof db)['Tool']> | null;
  }
): PersistedPrice => {
  return {
    id: price.publicId,
    ai_provider_id: price.aiProvider?.publicId ?? null,
    project_id: price.project?.publicId ?? null,
    tool_id: price.tool?.publicId ?? null,
    meter_type: price.meterType,
    provider: price.provider,
    model: price.model,
    component: price.component,
    unit: price.unit,
    quantity: price.quantity ?? null,
    unit_price: Number(price.unitPrice),
    effective_from: price.effectiveFrom,
    created_at: price.createdAt,
  };
};

/**
 * Returns the price row for one `(provider, model, component)`, resolving
 * most-specific first: a per-provider override (`aiProviderId` set) → a project
 * + provider-slug price (`projectId` set, `aiProviderId` null) → the global
 * default (both null). Within each scope the latest row with
 * `effectiveFrom <= at` applies. Null when no row covers it (the caller records
 * the component with `cost_usd = null`).
 */
export const getEffectivePrice = async (args: {
  provider: string;
  model: string;
  component: string;
  aiProviderId: number | null;
  projectId: number | null;
  at: Date;
}): Promise<InstanceType<(typeof db)['PriceBook']> | null> => {
  const base = {
    provider: args.provider,
    model: args.model,
    component: args.component,
    toolId: null,
    effectiveFrom: { [Op.lte]: args.at },
  };

  // Tier 1 — a specific AI provider instance.
  if (args.aiProviderId !== null) {
    const override = await db.PriceBook.findOne({
      where: { ...base, aiProviderId: args.aiProviderId },
      order: [['effectiveFrom', 'DESC']],
    });
    if (override) return override;
  }

  // Tier 2 — the project's rate for this provider slug.
  if (args.projectId !== null) {
    const projectPrice = await db.PriceBook.findOne({
      where: { ...base, aiProviderId: null, projectId: args.projectId },
      order: [['effectiveFrom', 'DESC']],
    });
    if (projectPrice) return projectPrice;
  }

  // Tier 3 — the global default.
  return db.PriceBook.findOne({
    where: { ...base, aiProviderId: null, projectId: null },
    order: [['effectiveFrom', 'DESC']],
  });
};

// Lists the global default prices only. Per-provider overrides and project +
// provider-slug prices are read through their own project-scoped endpoints, so
// one project never sees another's rates. Tool-keyed rows name a tool in some
// project, so they are listed to the operator alone.
export const listPrices = async (args: {
  includeToolRows: boolean;
}): Promise<{ prices: PersistedPrice[] }> => {
  const rows = await db.PriceBook.findAll({
    where: {
      aiProviderId: null,
      projectId: null,
      ...(args.includeToolRows ? {} : { toolId: null }),
    },
    include: [{ model: db.Tool, as: 'tool' }],
    order: [
      ['provider', 'ASC'],
      ['model', 'ASC'],
      ['component', 'ASC'],
      ['effectiveFrom', 'DESC'],
    ],
  });
  return { prices: rows.map(mapPrice) };
};

type PriceInput = {
  aiProviderId?: string | null;
  toolId?: string | null;
  quantity?: object | null;
  meterType?: string;
  provider: string;
  model: string;
  component: string;
  unit: string;
  unitPrice: number;
  effectiveFrom: string;
};

// Resolves an optional AI provider public ID to its internal id and the project
// it belongs to. Null (a global default row) passes through; an unknown
// provider is a bad request.
const resolveAiProvider = async (
  publicId: string | null | undefined
): Promise<{ id: number | null; projectId: number | null }> => {
  if (!publicId) return { id: null, projectId: null };
  const provider = await db.AiProvider.findOne({ where: { publicId } });
  if (!provider) {
    throw new DomainError(
      'AI_PROVIDER_NOT_FOUND',
      `AI provider '${publicId}' not found.`
    );
  }
  return { id: provider.id as number, projectId: provider.projectId };
};

// Throws VALIDATION_FAILED when required price fields are missing/invalid.
const assertPriceInput = (args: {
  component: string;
  unit: string;
  unitPrice: number;
}): void => {
  const error = validatePriceInput(args);
  if (error) throw new DomainError('VALIDATION_FAILED', error);
};

// Shared by every write path. Takes an already-resolved `effectiveFrom` so each
// caller enforces its own timestamp policy.
export const persistPriceRow = async (args: {
  aiProviderId: number | null;
  projectId: number | null;
  toolId?: number | null;
  quantity?: object | null;
  meterType?: string;
  provider: string;
  model: string;
  component: string;
  unit: string;
  unitPrice: number;
  effectiveFrom: Date;
}): Promise<number> => {
  assertPriceInput(args);

  const values = {
    aiProviderId: args.aiProviderId,
    projectId: args.projectId,
    toolId: args.toolId ?? null,
    quantity: args.quantity ?? null,
    meterType: args.meterType ?? DEFAULT_METER_TYPE,
    provider: args.provider,
    model: args.model,
    component: args.component,
    unit: args.unit,
    unitPrice: String(args.unitPrice),
    effectiveFrom: args.effectiveFrom,
  };

  const [row, created] = await db.PriceBook.findOrCreate({
    where: {
      aiProviderId: args.aiProviderId,
      projectId: args.projectId,
      toolId: values.toolId,
      provider: values.provider,
      model: values.model,
      component: values.component,
      effectiveFrom: values.effectiveFrom,
    },
    defaults: values,
  });

  if (!created) {
    await row.update({
      meterType: values.meterType,
      unit: values.unit,
      quantity: values.quantity,
      unitPrice: values.unitPrice,
    });
  }

  return row.id as number;
};

const loadPrices = async (ids: number[]): Promise<PersistedPrice[]> => {
  const rows = await db.PriceBook.findAll({
    where: { id: ids },
    include: [
      { model: db.AiProvider, as: 'aiProvider' },
      { model: db.Project, as: 'project' },
      { model: db.Tool, as: 'tool' },
    ],
  });
  return rows.map(mapPrice);
};

export const upsertPrices = async (args: {
  prices: PriceInput[];
}): Promise<{ prices: PersistedPrice[] }> => {
  const resolveEffectiveFrom = createEffectiveFromResolver({
    aiProviderId: null,
    projectId: null,
    now: new Date(),
  });
  const ids: number[] = [];
  for (const price of args.prices) {
    assertToolPriceFields(price);
    const provider = await resolveAiProvider(price.aiProviderId);
    const toolId = await resolvePriceToolId(price.toolId);
    ids.push(
      await persistPriceRow({
        aiProviderId: provider.id,
        projectId: null,
        toolId,
        quantity: price.quantity,
        meterType: price.meterType,
        provider: price.provider,
        model: price.model,
        component: price.component,
        unit: price.unit,
        unitPrice: price.unitPrice,
        effectiveFrom: await resolveEffectiveFrom({
          ...price,
          aiProviderId: provider.id,
          providerProjectId: provider.projectId,
          toolId,
        }),
      })
    );
  }
  return { prices: await loadPrices(ids) };
};

export type ProviderPriceInput = {
  meterType?: string;
  model: string;
  component: string;
  unit: string;
  unitPrice: number;
  effectiveFrom: string;
};

// Resolves an AI provider public ID to its internal id and provider slug, or
// throws when it does not exist.
const getProviderForPricing = async (
  aiProviderId: string
): Promise<{ id: number; provider: string; projectId: number }> => {
  const provider = await db.AiProvider.findOne({
    where: { publicId: aiProviderId },
  });
  if (!provider) {
    throw new DomainError(
      'AI_PROVIDER_NOT_FOUND',
      `AI provider '${aiProviderId}' not found.`
    );
  }
  return {
    id: provider.id as number,
    provider: provider.provider,
    projectId: provider.projectId,
  };
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
      ['component', 'ASC'],
      ['effectiveFrom', 'DESC'],
    ],
  });
  return { prices: rows.map(mapPrice) };
};

/**
 * Upserts per-provider price overrides for one AI provider instance. The
 * override's `provider` slug is taken from the AI provider itself — an override
 * only wins at cost time when its slug equals the provider's — so callers supply
 * just the model, component, unit, price, and `effectiveFrom`, which must be in
 * the future unless the `(model, component)` has no price row yet.
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
  const { id, provider, projectId } = await getProviderForPricing(
    args.aiProviderId
  );
  const resolveEffectiveFrom = createEffectiveFromResolver({
    aiProviderId: id,
    projectId: null,
    providerProjectId: projectId,
    now: new Date(),
  });
  const ids: number[] = [];
  for (const price of args.prices) {
    ids.push(
      await persistPriceRow({
        aiProviderId: id,
        projectId: null,
        meterType: price.meterType,
        provider,
        model: price.model,
        component: price.component,
        unit: price.unit,
        unitPrice: price.unitPrice,
        effectiveFrom: await resolveEffectiveFrom({ ...price, provider }),
      })
    );
  }
  return { prices: await loadPrices(ids) };
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
  meterType?: string;
  provider: string;
  model: string;
  component: string;
  unit: string;
  unitPrice: number;
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
      ['component', 'ASC'],
      ['effectiveFrom', 'DESC'],
    ],
  });
  return { prices: rows.map(mapPrice) };
};

/**
 * Upserts project + provider-slug price rows, keyed on
 * `(project, provider, model, component, effectiveFrom)`. Unlike the
 * per-provider path the caller supplies `provider` explicitly — the price
 * covers all of the project's instances of that slug. `effectiveFrom` must be in
 * the future unless the `(provider, model, component)` has no price row yet.
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
  const resolveEffectiveFrom = createEffectiveFromResolver({
    aiProviderId: null,
    projectId: id,
    now: new Date(),
  });
  const ids: number[] = [];
  for (const price of args.prices) {
    ids.push(
      await persistPriceRow({
        aiProviderId: null,
        projectId: id,
        meterType: price.meterType,
        provider: price.provider,
        model: price.model,
        component: price.component,
        unit: price.unit,
        unitPrice: price.unitPrice,
        effectiveFrom: await resolveEffectiveFrom(price),
      })
    );
  }
  return { prices: await loadPrices(ids) };
};
