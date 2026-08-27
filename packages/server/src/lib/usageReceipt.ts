import { db } from '../db';
import { orchestrationRuns } from './orchestrationAccessor';
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
  unit_price: number | null;
  price_id: string | null;
  cost_usd: number | null;
};

export type UsageReceiptLine = {
  event_id: string;
  meter_type: string;
  provider: string;
  model: string;
  // Grouping a run receipt's lines by this yields the per-node cost the run
  // total hides. A retried node's attempts share one `node_id` — the right
  // default for spend, since a retry is real money.
  node_id: string | null;
  cost_usd: number | null;
  components: UsageReceiptComponent[];
};

// One entry per meter type, so downstream billing reads the tokens/infra cost
// split without re-scanning the raw lines.
export type UsageReceiptMeterTypeTotal = {
  meter_type: string;
  cost_usd: number | null;
};

/** A receipt is a response body, so the type is the wire shape. */
export type UsageReceipt = {
  // Present on a per-generation receipt; absent on a per-run receipt.
  generation_id?: string;
  // Present on a per-run receipt (summed across the run's meters); absent on a
  // per-generation receipt.
  orchestration_run_id?: string;
  currency: string;
  line_items: UsageReceiptLine[];
  by_meter_type: UsageReceiptMeterTypeTotal[];
  total_input_tokens: number;
  total_output_tokens: number;
  total_cached_tokens: number;
  total_reasoning_tokens: number;
  total_cost_usd: number | null;
};

// The token/cost roll-up of a receipt without its line items — surfaced on the
// orchestration-run response so callers see run spend without a second request.
export type UsageTotals = {
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
        return stringOrNull(l.cost_usd);
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
    const group = linesByType.get(line.meter_type);
    if (group) {
      group.push(line);
    } else {
      linesByType.set(line.meter_type, [line]);
    }
  }
  return [...linesByType.entries()].map(([meterType, group]) => {
    return { meter_type: meterType, cost_usd: sumLineCosts(group) };
  });
};

// Loads a set of usage events (with their priced components) and maps them into
// receipt line items, oldest-first. Shared by the generation and run receipts.
const loadLineItems = async (
  where: Record<string, unknown>
): Promise<UsageReceiptLine[]> => {
  const events = await db.UsageEvent.findAll({
    where,
    include: [
      {
        model: db.UsageComponent,
        as: 'components',
        include: [{ model: db.PriceBook, as: 'price' }],
      },
    ],
    order: [['createdAt', 'ASC']],
  });

  return events.map((event) => {
    const components = (event.components ?? []).map((component) => {
      return {
        component: component.component,
        quantity: Number(component.quantity),
        unit: component.unit,
        billable: component.billable,
        unit_price:
          component.unitPrice === null ? null : Number(component.unitPrice),
        price_id: assocPublicId(component.price),
        cost_usd: component.costUsd === null ? null : Number(component.costUsd),
      };
    });
    return {
      event_id: event.publicId,
      meter_type: event.meterType,
      provider: event.provider,
      model: event.model,
      node_id: event.nodeId ?? null,
      cost_usd: event.costUsd === null ? null : Number(event.costUsd),
      components,
    };
  });
};

// Assembles the totals + breakdowns shared by every receipt shape from a set of
// line items. `identity` stamps the receipt with either a generationId or a
// orchestrationRunId (never both).
const assembleReceipt = (
  lineItems: UsageReceiptLine[],
  identity: { generation_id?: string; orchestration_run_id?: string }
): UsageReceipt => {
  // Reconstruct the provider's reported counts: `input_tokens` components hold
  // the uncached input, so full prompt tokens = input + cached.
  const cached = sumQuantity(lineItems, 'cached_tokens');
  return {
    ...identity,
    currency: 'USD',
    line_items: lineItems,
    by_meter_type: groupByMeterType(lineItems),
    total_input_tokens: sumQuantity(lineItems, 'input_tokens') + cached,
    total_output_tokens: sumQuantity(lineItems, 'output_tokens'),
    total_cached_tokens: cached,
    total_reasoning_tokens: sumQuantity(lineItems, 'reasoning_tokens'),
    total_cost_usd: sumLineCosts(lineItems),
  };
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

  const lineItems = await loadLineItems({ generationId: generation.id });
  return assembleReceipt(lineItems, { generation_id: args.generationId });
};

// Resolves an orchestration run's public id to its internal id within scope.
// Returns null when the run is not visible (the route yields 404).
const resolveRunInternalId = async (args: {
  orchestrationRunId: string;
  projectIds?: number[];
}): Promise<number | null> => {
  const run = await db.OrchestrationRun.findOne({
    where: orchestrationRuns.scopedWhere({
      id: args.orchestrationRunId,
      projectIds: args.projectIds,
    }),
  });
  return (run?.id as number | undefined) ?? null;
};

/**
 * Builds a billing receipt for an orchestration run: the same shape as the
 * per-generation receipt, but its line items are every usage event recorded
 * across the run's nodes (summed for the totals and the per-meter-type split).
 * "One operating cycle → one action" billing. Returns null when the run is not
 * visible in scope (the route yields 404).
 */
export const getRunReceipt = async (args: {
  orchestrationRunId: string;
  projectIds?: number[];
}): Promise<UsageReceipt | null> => {
  const runInternalId = await resolveRunInternalId(args);
  if (runInternalId === null) return null;

  const lineItems = await loadLineItems({ orchestrationRunId: runInternalId });
  return assembleReceipt(lineItems, {
    orchestration_run_id: args.orchestrationRunId,
  });
};

// The wire receipt projected down to the token/cost totals the run response
// carries. Shared by the self-only and nested roll-ups so the two can never
// disagree on how a total is derived.
const toTotals = (receipt: UsageReceipt): UsageTotals => {
  return {
    totalInputTokens: receipt.total_input_tokens,
    totalOutputTokens: receipt.total_output_tokens,
    totalCachedTokens: receipt.total_cached_tokens,
    totalReasoningTokens: receipt.total_reasoning_tokens,
    totalCostUsd: receipt.total_cost_usd,
  };
};

// Descendants of `runPublicId` as internal ids, excluding the run itself.
// Breadth-first per level rather than a recursive CTE, to stay in the query
// builder this module uses. `seen` guards a cycle that should be impossible:
// trusting it would loop forever on one bad row.
const descendantRunIds = async (args: {
  runPublicId: string;
}): Promise<number[]> => {
  const seen = new Set<string>([args.runPublicId]);
  const ids: number[] = [];
  let frontier = [args.runPublicId];

  while (frontier.length > 0) {
    const children = await db.OrchestrationRun.findAll({
      where: { parentRunId: frontier },
      attributes: ['id', 'publicId'],
    });
    const next: string[] = [];
    for (const child of children) {
      const publicId = child.publicId as string;
      if (seen.has(publicId)) continue;
      seen.add(publicId);
      ids.push(child.id as number);
      next.push(publicId);
    }
    frontier = next;
  }

  return ids;
};

/**
 * Rolls a run's usage up twice for the orchestration-run response:
 *
 * - `own` — the run's own nodes, which is what `usage` has always meant;
 * - `includingNested` — that plus every run its `loop` / `sub_orchestration`
 *   nodes started, at any depth, which is the figure to read for a graph that
 *   delegates (a child's events are attributed to the child).
 *
 * Both come from **one** read of the run's own events. The descendant walk runs
 * alongside that read rather than after it, and a run with no children reuses
 * the line items already in hand instead of re-reading them — so the two
 * figures are equal by construction rather than by a second query that happens
 * to agree. That case is both the common one and the hot one: this endpoint is
 * polled until a background run settles, and the event/component/price join is
 * the heaviest query in the read.
 *
 * Takes both ids because the caller has already loaded the run: the internal id
 * keys the events, the public id keys the parent link.
 */
export const getRunUsageRollups = async (args: {
  runInternalId: number;
  runPublicId: string;
}): Promise<{ own: UsageTotals; includingNested: UsageTotals }> => {
  const [ownLineItems, descendantIds] = await Promise.all([
    loadLineItems({ orchestrationRunId: args.runInternalId }),
    descendantRunIds({ runPublicId: args.runPublicId }),
  ]);

  const own = toTotals(assembleReceipt(ownLineItems, {}));
  if (descendantIds.length === 0) return { own, includingNested: own };

  const descendantLineItems = await loadLineItems({
    orchestrationRunId: descendantIds,
  });
  return {
    own,
    // Order-independent: every total is a sum over the components of every
    // line, so concatenating two ordered reads needs no re-sort.
    includingNested: toTotals(
      assembleReceipt([...ownLineItems, ...descendantLineItems], {})
    ),
  };
};
