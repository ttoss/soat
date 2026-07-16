import { db } from '../db';
import { sumComponentCostUsd } from './priceCompute';

const assocPublicId = (
  assoc: { publicId: string } | null | undefined
): string | null => {
  return assoc?.publicId ?? null;
};

export type UsageReceiptComponent = {
  component: string;
  quantity: number;
  unit: string;
  billable: boolean;
  unitPrice: number | null;
  priceId: string | null;
  costUsd: number | null;
};

export type UsageReceiptLine = {
  eventId: string;
  meterType: string;
  provider: string;
  model: string;
  costUsd: number | null;
  components: UsageReceiptComponent[];
};

// One entry per distinct meter type on the receipt, so downstream billing can
// read the "tokens + infra" cost split without re-scanning the raw lines. A
// single-type receipt (today's generations are all `llm_tokens`) has exactly
// one entry whose cost equals the receipt total.
export type UsageReceiptMeterTypeTotal = {
  meterType: string;
  costUsd: number | null;
};

export type UsageReceipt = {
  generationId: string;
  currency: string;
  lineItems: UsageReceiptLine[];
  byMeterType: UsageReceiptMeterTypeTotal[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalReasoningTokens: number;
  totalCostUsd: number | null;
};

const allComponents = (lines: UsageReceiptLine[]): UsageReceiptComponent[] => {
  return lines.flatMap((line) => {
    return line.components;
  });
};

// Sums the quantity of one component name across every line — used to
// reconstruct the provider's reported token counts from the component rows.
const sumQuantity = (lines: UsageReceiptLine[], component: string): number => {
  return allComponents(lines)
    .filter((c) => {
      return c.component === component;
    })
    .reduce((acc, c) => {
      return acc + c.quantity;
    }, 0);
};

const stringOrNull = (value: number | null): string | null => {
  return value === null ? null : String(value);
};

const numberOrNull = (value: string | null): number | null => {
  return value === null ? null : Number(value);
};

// Sums a set of line costs (via the shared string-decimal summer) into a number.
const sumLineCosts = (lines: UsageReceiptLine[]): number | null => {
  return numberOrNull(
    sumComponentCostUsd(
      lines.map((l) => {
        return stringOrNull(l.costUsd);
      })
    )
  );
};

// Rolls the lines up by meter type. `Map` iteration preserves insertion order,
// so the breakdown is deterministic and single-type receipts stay a one-element
// list without a separate order array.
const groupByMeterType = (
  lines: UsageReceiptLine[]
): UsageReceiptMeterTypeTotal[] => {
  const linesByType = new Map<string, UsageReceiptLine[]>();
  for (const line of lines) {
    const group = linesByType.get(line.meterType);
    if (group) {
      group.push(line);
    } else {
      linesByType.set(line.meterType, [line]);
    }
  }
  return [...linesByType.entries()].map(([meterType, group]) => {
    return { meterType, costUsd: sumLineCosts(group) };
  });
};

/**
 * Builds a billing receipt for a completed generation: one line item per usage
 * event (its SKU, cost, and component breakdown), a per-meter-type cost split,
 * reconstructed token totals, and a grand total. `totalCostUsd` is null only
 * when nothing on the receipt was priced. Returns null when the generation is
 * not visible in scope (the route yields 404).
 */
export const getReceipt = async (args: {
  generationId: string;
  projectIds?: number[];
}): Promise<UsageReceipt | null> => {
  const genWhere: { publicId: string; projectId?: number[] } = {
    publicId: args.generationId,
  };
  if (args.projectIds !== undefined) genWhere.projectId = args.projectIds;

  const generation = await db.Generation.findOne({ where: genWhere });
  if (!generation) return null;

  const events = await db.UsageEvent.findAll({
    where: { generationId: generation.id },
    include: [
      {
        model: db.UsageComponent,
        as: 'components',
        include: [{ model: db.PriceBook, as: 'price' }],
      },
    ],
    order: [['createdAt', 'ASC']],
  });

  const lineItems: UsageReceiptLine[] = events.map((event) => {
    const components = (event.components ?? []).map((component) => {
      return {
        component: component.component,
        quantity: Number(component.quantity),
        unit: component.unit,
        billable: component.billable,
        unitPrice:
          component.unitPrice === null ? null : Number(component.unitPrice),
        priceId: assocPublicId(component.price),
        costUsd: component.costUsd === null ? null : Number(component.costUsd),
      };
    });
    return {
      eventId: event.publicId,
      meterType: event.meterType,
      provider: event.provider,
      model: event.model,
      costUsd: event.costUsd === null ? null : Number(event.costUsd),
      components,
    };
  });

  // Reconstruct the provider's reported counts: `input_tokens` components hold
  // the uncached input, so full prompt tokens = input + cached.
  const cached = sumQuantity(lineItems, 'cached_tokens');

  return {
    generationId: args.generationId,
    currency: 'USD',
    lineItems,
    byMeterType: groupByMeterType(lineItems),
    totalInputTokens: sumQuantity(lineItems, 'input_tokens') + cached,
    totalOutputTokens: sumQuantity(lineItems, 'output_tokens'),
    totalCachedTokens: cached,
    totalReasoningTokens: sumQuantity(lineItems, 'reasoning_tokens'),
    totalCostUsd: sumLineCosts(lineItems),
  };
};
