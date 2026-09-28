import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { DomainError } from '../errors';
import { emitActivityEntry } from './activity';
import { evaluateLogic, isLogic } from './jsonLogicMapping';
import { computeComponentCostUsd } from './priceCompute';

const log = createDebug('soat:usage');

// The platform SKU every `tool_execution` event meters. A row naming a tool
// (`tool_id`) prices that tool's calls ahead of the generic row.
export const TOOL_PROVIDER = 'soat';
export const TOOL_MODEL = 'tool-call';
export const TOOL_COMPONENT = 'tool_call';

export const TOOL_EXECUTION_METER_TYPE = 'tool_execution';

export const TOOL_EXECUTION_OUTCOMES = ['ok', 'error', 'timeout'] as const;

export type ToolExecutionOutcome = (typeof TOOL_EXECUTION_OUTCOMES)[number];

/**
 * What a row's `quantity` expression reads. Deliberately narrow: no secrets,
 * no auth headers and no `tool_context`, which the caller writes.
 */
export type ToolCallQuantityContext = {
  input: Record<string, unknown>;
  action: string | null;
  response: unknown;
  outcome: ToolExecutionOutcome;
};

export type PricedToolComponent = {
  component: string;
  unit: string;
  quantity: string;
  unitPrice: string | null;
  costUsd: string | null;
  priceId: number | null;
};

type PriceRow = InstanceType<(typeof db)['PriceBook']>;

type ToolPriceFields = {
  meterType?: string;
  provider: string;
  model: string;
  aiProviderId?: string | null;
  toolId?: string | null;
  quantity?: unknown;
};

const isPresent = (value: unknown): boolean => {
  return value !== undefined && value !== null;
};

const isToolCallSku = (price: ToolPriceFields): boolean => {
  return (
    price.meterType === TOOL_EXECUTION_METER_TYPE &&
    price.provider === TOOL_PROVIDER &&
    price.model === TOOL_MODEL
  );
};

const toolPriceFieldViolation = (price: ToolPriceFields): string | null => {
  const hasToolId = isPresent(price.toolId);
  const hasQuantity = isPresent(price.quantity);
  if (!hasToolId && !hasQuantity) return null;
  if (!isToolCallSku(price)) {
    return `tool_id and quantity apply only to meter_type '${TOOL_EXECUTION_METER_TYPE}' rows for '${TOOL_PROVIDER}' / '${TOOL_MODEL}'.`;
  }
  if (hasToolId && isPresent(price.aiProviderId)) {
    return 'A price row names either ai_provider_id or tool_id, not both.';
  }
  if (hasQuantity && !isLogic(price.quantity)) {
    return 'quantity must be a JSON Logic expression (e.g. { "var": "response.page_count" }).';
  }
  return null;
};

/**
 * Refuses `tool_id` / `quantity` on a row they could never apply to: both are
 * read only off the `soat/tool-call` rows of the `tool_execution` meter, so
 * anywhere else they would be stored and silently ignored.
 */
export const assertToolPriceFields = (price: ToolPriceFields): void => {
  const violation = toolPriceFieldViolation(price);
  if (violation) throw new DomainError('VALIDATION_FAILED', violation);
};

/** Resolves a price row's `tool_id` to the tool's internal id. */
export const resolvePriceToolId = async (
  publicId: string | null | undefined
): Promise<number | null> => {
  if (!publicId) return null;
  const tool = await db.Tool.findOne({
    where: { publicId },
    attributes: ['id'],
  });
  if (!tool) {
    throw new DomainError('TOOL_NOT_FOUND', `Tool '${publicId}' not found.`);
  }
  return tool.id as number;
};

// Lower wins: the tool's own row, then the calling project's, then the default.
const tierOf = (row: PriceRow): number => {
  if (row.toolId !== null) return 0;
  if (row.projectId !== null) return 1;
  return 2;
};

const effectiveRowsByComponent = async (args: {
  toolId: number | null;
  projectId: number;
  at: Date;
}): Promise<Map<string, PriceRow>> => {
  const rows = await db.PriceBook.findAll({
    where: {
      provider: TOOL_PROVIDER,
      model: TOOL_MODEL,
      aiProviderId: null,
      effectiveFrom: { [Op.lte]: args.at },
      [Op.or]: [
        ...(args.toolId !== null
          ? [{ toolId: args.toolId, projectId: null }]
          : []),
        { toolId: null, projectId: args.projectId },
        { toolId: null, projectId: null },
      ],
    },
    order: [['effectiveFrom', 'DESC']],
  });
  // Rows arrive newest first, so the first row seen at a tier is its latest.
  const byComponent = new Map<string, PriceRow>();
  for (const row of rows) {
    const current = byComponent.get(row.component);
    if (!current || tierOf(row) < tierOf(current)) {
      byComponent.set(row.component, row);
    }
  }
  return byComponent;
};

type QuantityResult = { quantity: number } | { invalid: string };

const evaluateQuantity = (args: {
  expression: object | null;
  call: ToolCallQuantityContext;
}): QuantityResult => {
  if (args.expression === null) return { quantity: 1 };
  let value: unknown;
  try {
    value = evaluateLogic(args.expression, args.call);
  } catch (error) {
    return {
      invalid: `evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (typeof value !== 'number') {
    return {
      invalid: `evaluated to ${value === null ? 'null' : typeof value}`,
    };
  }
  if (!Number.isFinite(value) || value < 0) {
    return { invalid: `evaluated to ${value}` };
  }
  return { quantity: value };
};

const reportInvalidQuantity = async (args: {
  projectId: number;
  toolPublicId: string | null;
  row: PriceRow;
  reason: string;
}): Promise<void> => {
  log(
    'priceToolExecution: invalid quantity tool=%s component=%s price=%s reason=%s',
    args.toolPublicId,
    args.row.component,
    args.row.publicId,
    args.reason
  );
  await emitActivityEntry({
    projectId: args.projectId,
    kind: 'usage_quantity_invalid',
    summary: `A tool call's '${args.row.component}' quantity is not a finite number ≥ 0, so the component was recorded unpriced`,
    detail: {
      toolId: args.toolPublicId,
      component: args.row.component,
      priceId: args.row.publicId,
      reason: args.reason,
    },
    refId: args.toolPublicId,
  });
};

const priceComponent = (args: {
  row: PriceRow;
  call: ToolCallQuantityContext;
}): { component: PricedToolComponent; invalid: string | null } => {
  const { row } = args;
  const result = evaluateQuantity({
    expression: row.quantity,
    call: args.call,
  });
  if ('invalid' in result) {
    return {
      component: {
        component: row.component,
        unit: row.unit,
        quantity: '0',
        unitPrice: null,
        costUsd: null,
        priceId: null,
      },
      invalid: result.invalid,
    };
  }
  return {
    component: {
      component: row.component,
      unit: row.unit,
      quantity: String(result.quantity),
      unitPrice: String(row.unitPrice),
      costUsd: computeComponentCostUsd({
        quantity: result.quantity,
        unitPrice: Number(row.unitPrice),
      }),
      priceId: row.id as number,
    },
    invalid: null,
  };
};

/**
 * The components one tool call records: `tool_call` always, plus one per
 * component any effective row prices. Each component is priced by the tool's
 * own row, else the calling project's, else the default, and quantified by
 * that row's `quantity` (1 when absent).
 *
 * A quantity that is not a finite number ≥ 0 records the component unpriced
 * and emits a `usage_quantity_invalid` activity entry; it never throws, since
 * metering must not fail the call it measures.
 */
export const priceToolExecution = async (args: {
  toolId: number | null;
  toolPublicId: string | null;
  projectId: number;
  at: Date;
  call: ToolCallQuantityContext;
}): Promise<PricedToolComponent[]> => {
  const byComponent = await effectiveRowsByComponent(args);
  const components: PricedToolComponent[] = [];
  if (!byComponent.has(TOOL_COMPONENT)) {
    components.push({
      component: TOOL_COMPONENT,
      unit: TOOL_COMPONENT,
      quantity: '1',
      unitPrice: null,
      costUsd: null,
      priceId: null,
    });
  }
  const ordered = [...byComponent.values()].sort((a, b) => {
    if (a.component === TOOL_COMPONENT) return -1;
    if (b.component === TOOL_COMPONENT) return 1;
    return a.component.localeCompare(b.component);
  });
  for (const row of ordered) {
    const priced = priceComponent({ row, call: args.call });
    components.push(priced.component);
    if (priced.invalid !== null) {
      await reportInvalidQuantity({
        projectId: args.projectId,
        toolPublicId: args.toolPublicId,
        row,
        reason: priced.invalid,
      });
    }
  }
  return components;
};
