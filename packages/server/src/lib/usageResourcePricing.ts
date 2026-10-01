import { Op } from '@ttoss/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { emitActivityEntry } from './activity';
import { applyToolOutputMapping, evaluateLogic } from './jsonLogicMapping';
import { RESOURCE_PROVIDER } from './priceBookResource';
import { computeComponentCostUsd } from './priceCompute';
import { toolReferences } from './resourceReferences';

const log = createDebug('soat:usage');

/** What a tool call sent, reported by the call site when the request leaves. */
export type SentToolCall = { input?: unknown; action?: string };

/** One metered tool call, as a resource row's `quantity` reads it. */
export type ToolCallRecord = SentToolCall & {
  response: unknown;
  outcome: string;
  durationMs: number;
};

export type PricedResourceComponent = {
  component: string;
  quantity: number;
  unit: string;
  billable: true;
  unitPrice: string;
  costUsd: string | null;
  priceId: number;
};

export type InvalidQuantity = {
  resource: string;
  component: string;
  priceId: string;
};

type PriceRow = InstanceType<(typeof db)['PriceBook']>;

/**
 * The resource rows in effect for one tool, one per component: the owner's
 * project rows first, then the global ones. A caller's rows never apply.
 */
const findEffectiveResourceRows = async (args: {
  resource: string;
  ownerProjectId: number;
  at: Date;
}): Promise<PriceRow[]> => {
  const rows = await db.PriceBook.findAll({
    where: {
      provider: RESOURCE_PROVIDER,
      model: args.resource,
      aiProviderId: null,
      effectiveFrom: { [Op.lte]: args.at },
      [Op.or]: [{ projectId: args.ownerProjectId }, { projectId: null }],
    },
    order: [['effectiveFrom', 'DESC']],
  });
  const byComponent = new Map<string, PriceRow>();
  for (const row of rows) {
    const held = byComponent.get(row.component);
    if (!held || (held.projectId === null && row.projectId !== null)) {
      byComponent.set(row.component, row);
    }
  }
  return [...byComponent.values()];
};

const readQuantity = (args: {
  expression: unknown;
  context: Record<string, unknown>;
}): number | null => {
  if (args.expression === null || args.expression === undefined) return 1;
  try {
    const value = evaluateLogic(args.expression, args.context);
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : null;
  } catch {
    return null;
  }
};

// Never in the context: secrets, resolved headers, `tool_context`.
const buildToolContext = async (args: {
  toolId: string;
  ownerProjectId: number;
  call: ToolCallRecord;
}): Promise<Record<string, unknown>> => {
  const tool = await toolReferences.find({
    id: args.toolId,
    projectId: args.ownerProjectId,
    reach: 'project',
  });
  const input = args.call.input ?? {};
  const response =
    args.call.outcome === 'ok'
      ? applyToolOutputMapping(
          (tool?.outputMapping as Record<string, unknown> | null) ?? null,
          args.call.response,
          input as Record<string, unknown>
        )
      : null;
  return {
    input,
    action: args.call.action ?? null,
    response,
    outcome: args.call.outcome,
    duration_ms: args.call.durationMs,
  };
};

/**
 * The components a resource's rows add to one of its metered events. The
 * context is built only when a row prices the resource. A quantity that is not
 * a finite number >= 0 is recorded as `0` with no cost and reported in
 * `invalid`, so metering never fails the call it measures.
 */
export const priceResource = async (args: {
  type: 'tool' | 'agent';
  id: string;
  ownerProjectId: number;
  buildContext: () => Promise<Record<string, unknown>>;
}): Promise<{
  components: PricedResourceComponent[];
  invalid: InvalidQuantity[];
}> => {
  const owner = await db.Project.findByPk(args.ownerProjectId, {
    attributes: ['publicId'],
  });
  if (!owner) return { components: [], invalid: [] };
  const resource = `srn:${owner.publicId}:${args.type}:${args.id}`;
  const rows = await findEffectiveResourceRows({
    resource,
    ownerProjectId: args.ownerProjectId,
    at: new Date(),
  });
  if (rows.length === 0) return { components: [], invalid: [] };
  log('priceResource: %s rows=%d', resource, rows.length);

  const context = await args.buildContext();
  const components: PricedResourceComponent[] = [];
  const invalid: InvalidQuantity[] = [];
  for (const row of rows) {
    const quantity = readQuantity({ expression: row.quantity, context });
    if (quantity === null) {
      invalid.push({
        resource,
        component: row.component,
        priceId: row.publicId,
      });
    }
    components.push({
      component: row.component,
      quantity: quantity ?? 0,
      unit: row.unit,
      billable: true,
      unitPrice: row.unitPrice,
      costUsd:
        quantity === null
          ? null
          : computeComponentCostUsd({
              quantity,
              unitPrice: Number(row.unitPrice),
            }),
      priceId: row.id as number,
    });
  }
  return { components, invalid };
};

/** The components a tool's resource rows add to one of its calls. */
export const priceToolResource = (args: {
  toolId: string;
  ownerProjectId: number;
  call: ToolCallRecord;
}) => {
  return priceResource({
    type: 'tool',
    id: args.toolId,
    ownerProjectId: args.ownerProjectId,
    buildContext: () => {
      return buildToolContext(args);
    },
  });
};

/**
 * One `usage_quantity_invalid` entry per unreadable quantity, in the project
 * the event is metered in, referencing the tool or agent its SRN names.
 */
export const reportInvalidQuantities = async (args: {
  projectId: number;
  invalid: InvalidQuantity[];
}): Promise<void> => {
  for (const entry of args.invalid) {
    await emitActivityEntry({
      projectId: args.projectId,
      kind: 'usage_quantity_invalid',
      summary: `Price ${entry.priceId} of ${entry.resource} read no valid quantity for '${entry.component}'`,
      detail: { ...entry },
      refId: entry.resource.slice(entry.resource.lastIndexOf(':') + 1),
    });
  }
};
