import { randomUUID } from 'node:crypto';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { isPlainObject } from './plainObject';
import { sumComponentCostUsd } from './priceCompute';
import { insertUsageEvent } from './usageEventWrite';
import {
  priceToolExecution,
  TOOL_EXECUTION_METER_TYPE,
  TOOL_MODEL,
  TOOL_PROVIDER,
  type ToolCallQuantityContext,
  type ToolExecutionOutcome,
} from './usageToolPricing';

const log = createDebug('soat:usage');

/**
 * What the dispatching call site knows about who made a tool call. Every field
 * is optional because each site holds a different subset; a site that holds
 * an id passes it. A `generationId` wins over the explicit agent, run, node
 * and trigger: they are read off the generation's own columns, so a caller
 * cannot attribute a call to a turn it did not make.
 */
export type ToolCallAttribution = {
  generationId?: string | null;
  agentId?: string | null;
  orchestrationRunId?: string | null;
  nodeId?: string | null;
  triggerId?: string | null;
  // What the call was made for when it is not production traffic.
  source?: string | null;
  // The guardrails whose evaluation released the call — a pipeline passes its
  // own to every step, which adds the step's.
  guardrailIds?: readonly string[];
};

/** The meter a primitive records against: the tool and the caller. */
export type ToolExecutionMeter = {
  // The calling project, which the event is written to — for a published tool,
  // not the project that owns it.
  projectId: number;
  // Public id; null for an inline (unpersisted) definition.
  toolId: string | null;
  attribution: ToolCallAttribution;
};

/** The attribution a nested call inherits, with the gate that released it added. */
export const withReleasingGuardrails = (args: {
  attribution: ToolCallAttribution;
  guardrailIds: readonly string[];
}): ToolCallAttribution => {
  if (args.guardrailIds.length === 0) return args.attribution;
  return {
    ...args.attribution,
    guardrailIds: [
      ...new Set([
        ...(args.attribution.guardrailIds ?? []),
        ...args.guardrailIds,
      ]),
    ],
  };
};

// Every timeout a primitive can raise: `AbortSignal.timeout` (mcp),
// `withCallTimeout` (builtin), and undici's connect/headers/body timeouts
// (http), which arrive as the `cause` of a `fetch failed` TypeError.
const isTimeoutNode = (node: object): boolean => {
  if ('name' in node && node.name === 'TimeoutError') return true;
  if ('cause' in node && node.cause === 'SOAT_TOOL_CALL_TIMEOUT_MS') {
    return true;
  }
  return (
    'code' in node &&
    typeof node.code === 'string' &&
    node.code.startsWith('UND_ERR_') &&
    node.code.endsWith('TIMEOUT')
  );
};

const isTimeoutError = (error: unknown): boolean => {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    if (isTimeoutNode(current)) return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
};

type ResolvedAttribution = {
  toolId: number | null;
  agentId: number | null;
  generationId: number | null;
  generationPublicId: string | null;
  orchestrationRunId: number | null;
  nodeId: string | null;
  traceId: number | null;
  actorId: number | null;
  sessionId: number | null;
  triggerId: string | null;
  actionId: string | null;
  source: string | null;
};

const internalId = async (args: {
  model: 'Agent' | 'OrchestrationRun';
  projectId: number;
  publicId: string | null | undefined;
}): Promise<number | null> => {
  if (!args.publicId) return null;
  const where = { publicId: args.publicId, projectId: args.projectId };
  const row =
    args.model === 'Agent'
      ? await db.Agent.findOne({ where, attributes: ['id'] })
      : await db.OrchestrationRun.findOne({ where, attributes: ['id'] });
  return (row?.id as number | undefined) ?? null;
};

// Not scoped to the calling project: a published tool lives in another one.
// The id comes from the dispatching site, never from the caller.
const toolInternalId = async (
  publicId: string | null
): Promise<number | null> => {
  if (!publicId) return null;
  const row = await db.Tool.findOne({
    where: { publicId },
    attributes: ['id'],
  });
  return (row?.id as number | undefined) ?? null;
};

const resolveAttribution = async (
  meter: ToolExecutionMeter
): Promise<ResolvedAttribution> => {
  const { projectId, attribution } = meter;
  const toolId = await toolInternalId(meter.toolId);

  const generation = attribution.generationId
    ? await db.Generation.findOne({
        where: { publicId: attribution.generationId, projectId },
      })
    : null;

  if (generation) {
    return {
      toolId,
      agentId: generation.agentId,
      generationId: generation.id,
      generationPublicId: generation.publicId,
      orchestrationRunId: await internalId({
        model: 'OrchestrationRun',
        projectId,
        publicId: generation.orchestrationRunId,
      }),
      nodeId: generation.nodeId,
      traceId: generation.traceId,
      actorId: generation.startedByActorId,
      sessionId: generation.sessionId,
      triggerId: generation.triggerId,
      actionId: generation.actionId,
      source: generation.source ?? attribution.source ?? null,
    };
  }

  return {
    toolId,
    agentId: await internalId({
      model: 'Agent',
      projectId,
      publicId: attribution.agentId,
    }),
    generationId: null,
    generationPublicId: null,
    orchestrationRunId: await internalId({
      model: 'OrchestrationRun',
      projectId,
      publicId: attribution.orchestrationRunId,
    }),
    nodeId: attribution.nodeId ?? null,
    traceId: null,
    actorId: null,
    sessionId: null,
    triggerId: attribution.triggerId ?? null,
    actionId: null,
    source: attribution.source ?? null,
  };
};

const persistToolExecution = async (args: {
  meter: ToolExecutionMeter;
  call: ToolCallQuantityContext;
}): Promise<void> => {
  const resolved = await resolveAttribution(args.meter);
  const guardrailIds = args.meter.attribution.guardrailIds ?? [];
  const components = await priceToolExecution({
    toolId: resolved.toolId,
    toolPublicId: args.meter.toolId,
    projectId: args.meter.projectId,
    at: new Date(),
    call: args.call,
  });
  // A tool call has no replay identity: a retry is a second call on the wire
  // and meters as one, so the key is unique per execution.
  const idempotencyKey = `tool:${randomUUID()}`;

  await db.sequelize.transaction(async (transaction) => {
    const [event, created] = await insertUsageEvent({
      defaults: {
        projectId: args.meter.projectId,
        ...resolved,
        aiProviderId: null,
        outcome: args.call.outcome,
        guardrailIds: guardrailIds.length > 0 ? [...guardrailIds] : null,
        meterType: TOOL_EXECUTION_METER_TYPE,
        provider: TOOL_PROVIDER,
        model: TOOL_MODEL,
        costUsd: sumComponentCostUsd(
          components.map((component) => {
            return component.costUsd;
          })
        ),
        idempotencyKey,
      },
      transaction,
    });
    if (!created) return;

    for (const component of components) {
      await db.UsageComponent.create(
        {
          publicId: generatePublicId(PUBLIC_ID_PREFIXES.usageComponent),
          usageEventId: event.id,
          component: component.component,
          quantity: component.quantity,
          unit: component.unit,
          billable: true,
          unitPrice: component.unitPrice,
          costUsd: component.costUsd,
          priceId: component.priceId,
        },
        { transaction }
      );
    }
  });
};

/**
 * Runs one outbound tool call and writes its `tool_execution` event.
 *
 * `send` calls `markSent` the moment the request leaves: a call refused before
 * that (an egress block, an unresolvable template) is not an execution and
 * writes nothing, while one that went out is recorded whatever the target
 * answered. `input` (the arguments sent) and `action`, with the answer and the
 * outcome, are what a price row's `quantity` reads. The write is awaited so a
 * guardrail counting this tool's calls sees it on the next call, and never
 * throws: metering must not fail the call it measures.
 */
export const meterToolExecution = async <T>(args: {
  meter: ToolExecutionMeter;
  input: unknown;
  action?: string | null;
  send: (markSent: () => void) => Promise<T>;
}): Promise<T> => {
  let sent = false;
  let outcome: ToolExecutionOutcome = 'ok';
  let response: unknown = null;
  try {
    const result = await args.send(() => {
      sent = true;
    });
    response = result;
    return result;
  } catch (error) {
    outcome = isTimeoutError(error) ? 'timeout' : 'error';
    throw error;
  } finally {
    if (sent) {
      try {
        await persistToolExecution({
          meter: args.meter,
          call: {
            input: isPlainObject(args.input) ? args.input : {},
            action: args.action ?? null,
            response,
            outcome,
          },
        });
      } catch (error) {
        log(
          'meterToolExecution: failed tool=%s error=%s',
          args.meter.toolId,
          error instanceof Error ? error.message : String(error)
        );
      }
    }
  }
};
