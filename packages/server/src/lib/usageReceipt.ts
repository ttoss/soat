import { db } from '../db';

const assocPublicId = (
  assoc: { publicId: string } | null | undefined
): string | null => {
  return assoc?.publicId ?? null;
};

export type UsageReceiptLine = {
  meterType: string;
  provider: string;
  model: string;
  priceId: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  quantity: number | null;
  unit: string | null;
  costUsd: number | null;
};

// One entry per distinct meter type on the receipt, so downstream billing can
// read the "tokens + infra" split without re-scanning the raw lines. A
// single-type receipt (today's generations are all `llm_tokens`) has exactly
// one entry whose totals equal the receipt totals.
export type UsageReceiptMeterTypeTotal = {
  meterType: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  quantity: number | null;
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

const sumField = (
  lines: UsageReceiptLine[],
  pick: (line: UsageReceiptLine) => number
): number => {
  return lines.reduce((acc, line) => {
    return acc + pick(line);
  }, 0);
};

// Sums the nullable columns (`costUsd`, `quantity`), staying null when no line
// contributes a value (mirrors the row-level "captured but not priced" / "not a
// quantity meter" semantics).
const sumNullable = (
  lines: UsageReceiptLine[],
  pick: (line: UsageReceiptLine) => number | null
): number | null => {
  const values = lines.map(pick).filter((value): value is number => {
    return value !== null;
  });
  return values.length
    ? values.reduce((acc, v) => {
        return acc + v;
      }, 0)
    : null;
};

const sumLines = (
  meterType: string,
  lines: UsageReceiptLine[]
): UsageReceiptMeterTypeTotal => {
  return {
    meterType,
    inputTokens: sumField(lines, (l) => {
      return l.inputTokens;
    }),
    outputTokens: sumField(lines, (l) => {
      return l.outputTokens;
    }),
    cachedTokens: sumField(lines, (l) => {
      return l.cachedTokens;
    }),
    reasoningTokens: sumField(lines, (l) => {
      return l.reasoningTokens;
    }),
    quantity: sumNullable(lines, (l) => {
      return l.quantity;
    }),
    costUsd: sumNullable(lines, (l) => {
      return l.costUsd;
    }),
  };
};

// Groups lines by meter type, preserving first-seen order, so the breakdown is
// deterministic and single-type receipts stay a one-element list.
const groupByMeterType = (
  lineItems: UsageReceiptLine[]
): UsageReceiptMeterTypeTotal[] => {
  const order: string[] = [];
  const byType = new Map<string, UsageReceiptLine[]>();
  for (const line of lineItems) {
    if (!byType.has(line.meterType)) {
      byType.set(line.meterType, []);
      order.push(line.meterType);
    }
    byType.get(line.meterType)?.push(line);
  }
  return order.map((type) => {
    return sumLines(type, byType.get(type) ?? []);
  });
};

/**
 * Builds a billing receipt for a completed generation: one line item per meter
 * row (model, tokens, the price-book version that priced it, and cost), a
 * per-meter-type breakdown, and totals. `totalCostUsd` is null only when no
 * line is priced. Returns null when the generation is not visible in scope (the
 * route yields 404).
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

  const meters = await db.UsageMeter.findAll({
    where: { generationId: generation.id },
    include: [{ model: db.PriceBook, as: 'price' }],
    order: [['createdAt', 'ASC']],
  });

  const lineItems: UsageReceiptLine[] = meters.map((meter) => {
    return {
      meterType: meter.meterType,
      provider: meter.provider,
      model: meter.model,
      priceId: assocPublicId(meter.price),
      inputTokens: meter.inputTokens,
      outputTokens: meter.outputTokens,
      cachedTokens: meter.cachedTokens,
      reasoningTokens: meter.reasoningTokens,
      quantity: meter.quantity === null ? null : Number(meter.quantity),
      unit: meter.unit,
      costUsd: meter.costUsd === null ? null : Number(meter.costUsd),
    };
  });

  return {
    generationId: args.generationId,
    currency: 'USD',
    lineItems,
    byMeterType: groupByMeterType(lineItems),
    totalInputTokens: sumField(lineItems, (l) => {
      return l.inputTokens;
    }),
    totalOutputTokens: sumField(lineItems, (l) => {
      return l.outputTokens;
    }),
    totalCachedTokens: sumField(lineItems, (l) => {
      return l.cachedTokens;
    }),
    totalReasoningTokens: sumField(lineItems, (l) => {
      return l.reasoningTokens;
    }),
    totalCostUsd: sumNullable(lineItems, (l) => {
      return l.costUsd;
    }),
  };
};
