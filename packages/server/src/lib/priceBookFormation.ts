// Formation-managed project prices — the write path behind the `project_price`
// formation resource. A formation owns a single project + provider-slug price
// row declaratively. Unlike the REST/admin paths, `effective_from` is not
// restricted to the future — the formation is the source of truth and its
// deploy is idempotent — and it defaults to deploy time so a freshly deployed
// price is live immediately. Already-recorded costs are safe regardless: usage
// components snapshot the charged `unit_price` and `cost_usd` at record time.

import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import type { PersistedPrice } from './priceBook';
import { mapPrice, persistPriceRow } from './priceBook';
import { validatePriceInput } from './priceCompute';

const log = createDebug('soat:priceBookFormation');

// Parses an optional formation `effective_from` string, defaulting to now.
const resolveFormationEffectiveFrom = (value: string | undefined): Date => {
  if (value === undefined) return new Date();
  const effectiveFrom = new Date(value);
  if (Number.isNaN(effectiveFrom.getTime())) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `effective_from must be a valid timestamp (got '${value}').`
    );
  }
  return effectiveFrom;
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

// Loads a single mapped price row by internal id (with scope associations).
const loadPriceById = async (id: number): Promise<PersistedPrice> => {
  const row = await db.PriceBook.findOne({
    where: { id },
    include: [
      { model: db.AiProvider, as: 'aiProvider' },
      { model: db.Project, as: 'project' },
    ],
  });
  /* istanbul ignore next */
  if (!row) {
    throw new DomainError('RESOURCE_NOT_FOUND', `Price '${id}' not found.`);
  }
  return mapPrice(row);
};

export type FormationProjectPriceInput = {
  projectId: number;
  meterType?: string;
  provider: string;
  model: string;
  component: string;
  unit: string;
  unitPrice: number;
  effectiveFrom?: string;
};

// Upserts the project-scoped price row for a formation `project_price` resource
// and returns it (its public ID is the formation physical resource id).
export const createFormationProjectPrice = async (
  args: FormationProjectPriceInput
): Promise<PersistedPrice> => {
  log(
    'createFormationProjectPrice: projectId=%d provider=%s model=%s component=%s',
    args.projectId,
    args.provider,
    args.model,
    args.component
  );
  const id = await persistPriceRow({
    aiProviderId: null,
    projectId: args.projectId,
    meterType: args.meterType,
    provider: args.provider,
    model: args.model,
    component: args.component,
    unit: args.unit,
    unitPrice: args.unitPrice,
    effectiveFrom: resolveFormationEffectiveFrom(args.effectiveFrom),
  });
  return loadPriceById(id);
};

// Reads back a formation-managed project price by its public ID, or null when
// the row no longer exists (drift).
export const getFormationProjectPrice = async (args: {
  id: string;
}): Promise<PersistedPrice | null> => {
  const row = await db.PriceBook.findOne({
    where: { publicId: args.id },
    include: [
      { model: db.AiProvider, as: 'aiProvider' },
      { model: db.Project, as: 'project' },
    ],
  });
  if (!row) return null;
  return mapPrice(row);
};

// Builds the DB patch from only the fields the formation actually resolved,
// converting each to its persisted representation.
const buildPricePatch = (args: {
  meterType?: string;
  provider?: string;
  model?: string;
  component?: string;
  unit?: string;
  unitPrice?: number;
  effectiveFrom?: string;
}): Record<string, unknown> => {
  const patch: Record<string, unknown> = {
    meterType: args.meterType,
    provider: args.provider,
    model: args.model,
    component: args.component,
    unit: args.unit,
    unitPrice:
      args.unitPrice === undefined ? undefined : String(args.unitPrice),
    effectiveFrom:
      args.effectiveFrom === undefined
        ? undefined
        : resolveFormationEffectiveFrom(args.effectiveFrom),
  };
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => {
      return value !== undefined;
    })
  );
};

// Updates a formation-managed project price in place, keyed by its public ID.
// Only the fields the formation resolves are changed. Mutating a row is safe:
// recorded usage components carry their own frozen price snapshot.
export const updateFormationProjectPrice = async (args: {
  id: string;
  meterType?: string;
  provider?: string;
  model?: string;
  component?: string;
  unit?: string;
  unitPrice?: number;
  effectiveFrom?: string;
}): Promise<PersistedPrice> => {
  log('updateFormationProjectPrice: id=%s', args.id);
  const row = await db.PriceBook.findOne({ where: { publicId: args.id } });
  if (!row) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Project price '${args.id}' not found.`
    );
  }

  assertPriceInput({
    component: args.component ?? row.component,
    unit: args.unit ?? row.unit,
    unitPrice: args.unitPrice ?? Number(row.unitPrice),
  });

  await row.update(buildPricePatch(args));
  return loadPriceById(row.id as number);
};

// Deletes a formation-managed project price by its public ID. A missing row is
// a no-op — the desired end state (absent) already holds.
export const deleteFormationProjectPrice = async (args: {
  id: string;
}): Promise<void> => {
  log('deleteFormationProjectPrice: id=%s', args.id);
  const row = await db.PriceBook.findOne({ where: { publicId: args.id } });
  if (row) await row.destroy();
};
