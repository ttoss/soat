import { db } from '../db';
import { DomainError } from '../errors';

type PriceScopeWhere = {
  aiProviderId: number | null;
  projectId?: number | null;
};

/**
 * The scopes a cost for this `(provider, model, component)` could already have
 * been resolved from, given the scope being written — the write's own scope
 * plus every broader one `getEffectivePrice` would fall through to. A
 * per-provider override back-dated past a project or global row that was
 * already pricing that provider would leave a recorded cost unexplainable by
 * the rows that produce it, which is the case immutability exists for.
 */
const priorPriceScopes = (args: {
  aiProviderId: number | null;
  projectId: number | null;
  providerProjectId: number | null;
}): PriceScopeWhere[] => {
  if (args.aiProviderId !== null) {
    return [
      { aiProviderId: args.aiProviderId },
      { aiProviderId: null, projectId: args.providerProjectId },
      { aiProviderId: null, projectId: null },
    ];
  }
  if (args.projectId !== null) {
    return [
      { aiProviderId: null, projectId: args.projectId },
      { aiProviderId: null, projectId: null },
    ];
  }
  return [{ aiProviderId: null, projectId: null }];
};

const hasPriorPriceRow = async (args: {
  scopes: PriceScopeWhere[];
  provider: string;
  model: string;
  component: string;
}): Promise<boolean> => {
  for (const scope of args.scopes) {
    const row = await db.PriceBook.findOne({
      where: {
        ...scope,
        provider: args.provider,
        model: args.model,
        component: args.component,
      },
    });
    if (row) return true;
  }
  return false;
};

/**
 * Resolves `effective_from` for one write, enforcing immutability only where
 * there is something to protect.
 *
 * A future timestamp always passes. A past or present one passes when nothing
 * has ever priced that `(provider, model, component)` in the write's own scope
 * or any broader one: no row exists to be rewritten, and no cost was frozen
 * against one. Requiring the future there instead opens a window in which a
 * provider is live and unpriced, and a generation landing inside it is metered
 * at zero permanently — the cost is frozen when the event is written, so the
 * row arriving a moment later cannot reach back (#1196).
 *
 * Memoised per request, and each key is checked before it is written, so a
 * batch carrying several rows for one key reads "already priced" as of the
 * request rather than as of its own earlier row.
 */
export const createEffectiveFromResolver = (args: {
  aiProviderId: number | null;
  projectId: number | null;
  providerProjectId?: number | null;
  now: Date;
}) => {
  const priced = new Map<string, boolean>();

  return async (price: {
    provider: string;
    model: string;
    component: string;
    effectiveFrom: string;
    aiProviderId?: number | null;
    providerProjectId?: number | null;
  }): Promise<Date> => {
    const effectiveFrom = new Date(price.effectiveFrom);
    if (Number.isNaN(effectiveFrom.getTime())) {
      throw new DomainError(
        'VALIDATION_FAILED',
        `effective_from must be a valid timestamp (got '${price.effectiveFrom}').`
      );
    }
    if (effectiveFrom > args.now) return effectiveFrom;

    const aiProviderId = price.aiProviderId ?? args.aiProviderId;
    const providerProjectId =
      price.providerProjectId ?? args.providerProjectId ?? null;
    const key = [
      aiProviderId,
      args.projectId,
      price.provider,
      price.model,
      price.component,
    ].join('\u0000');

    let alreadyPriced = priced.get(key);
    if (alreadyPriced === undefined) {
      alreadyPriced = await hasPriorPriceRow({
        scopes: priorPriceScopes({
          aiProviderId,
          projectId: args.projectId,
          providerProjectId,
        }),
        provider: price.provider,
        model: price.model,
        component: price.component,
      });
      priced.set(key, alreadyPriced);
    }

    if (alreadyPriced) {
      throw new DomainError(
        'VALIDATION_FAILED',
        `effective_from must be in the future for '${price.model}' / '${price.component}', which is already priced — past prices are immutable, so ship corrections as new future-dated rows (got '${price.effectiveFrom}').`
      );
    }

    return effectiveFrom;
  };
};
