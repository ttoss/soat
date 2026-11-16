import { randomUUID } from 'node:crypto';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import type { AssertionSender } from './assertionSender';
import { resolveEndUserAttribution } from './generationAttribution';
import { sumComponentCostUsd } from './priceCompute';
import { isTimeoutError } from './timeoutError';
import { insertUsageEvent, reportLostUsageEvent } from './usageEventWrite';
import {
  priceToolResource,
  reportInvalidQuantities,
  type SentToolCall,
  type ToolCallRecord,
} from './usageResourcePricing';
import { workAuthorityMissing } from './workAuthority';

const log = createDebug('soat:usage');

// A platform meter: one unpriced `tool_call` component per event, plus one per
// resource row the tool's owner prices it with. With none priced the event's
// `cost_usd` stays null ("captured, not yet priced").
const TOOL_PROVIDER = 'soat';
const TOOL_MODEL = 'tool-call';
const TOOL_COMPONENT = 'tool_call';

export const TOOL_EXECUTION_METER_TYPE = 'tool_execution';

export const TOOL_EXECUTION_OUTCOMES = ['ok', 'error', 'timeout'] as const;

export type ToolExecutionOutcome = (typeof TOOL_EXECUTION_OUTCOMES)[number];

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
  // The end user of a call no generation makes — a converter tool run for an
  // ingest that named one. Public ids, validated by that entry point.
  sessionId?: string | null;
  actorId?: string | null;
  // What the call was made for when it is not production traffic.
  source?: string | null;
  // The guardrails whose evaluation released the call — a pipeline passes its
  // own to every step, which adds the step's.
  guardrailIds?: readonly string[];
};

/** The meter a primitive records against: the tool, its project, and the caller. */
export type ToolExecutionMeter = {
  /** The tool's own project, where its secrets resolve. */
  projectId: number;
  /**
   * The project the call is metered in, when the tool is another project's
   * reached through a share; the event then names `projectId` as publisher.
   */
  callerProjectId?: number;
  // Public id; null for an inline (unpersisted) definition.
  toolId: string | null;
  /**
   * The durable work making the call (`WorkAuthority.work`), signed as the
   * assertion's `work_id`; null for a call no work makes.
   */
  workId: string | null;
  attribution: ToolCallAttribution;
  /** Whose authority the call's assertion carries. */
  sender: AssertionSender;
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

type ResolvedAttribution = {
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
  model: 'Tool' | 'Agent' | 'OrchestrationRun';
  projectId: number;
  publicId: string | null | undefined;
}): Promise<number | null> => {
  if (!args.publicId) return null;
  const where = { publicId: args.publicId, projectId: args.projectId };
  const row =
    args.model === 'Tool'
      ? await db.Tool.findOne({ where, attributes: ['id'] })
      : args.model === 'Agent'
        ? await db.Agent.findOne({ where, attributes: ['id'] })
        : await db.OrchestrationRun.findOne({ where, attributes: ['id'] });
  return (row?.id as number | undefined) ?? null;
};

/** The project an event belongs to: the caller's, which pays for the call. */
const eventProjectId = (meter: CallerMeter): number => {
  return meter.callerProjectId ?? meter.projectId;
};

type CallerMeter = Pick<
  ToolExecutionMeter,
  'projectId' | 'callerProjectId' | 'attribution'
>;

// The caller's turn, agent and run, in the caller's project.
const resolveAttribution = async (
  meter: CallerMeter
): Promise<ResolvedAttribution> => {
  const { attribution } = meter;
  const projectId = eventProjectId(meter);

  const generation = attribution.generationId
    ? await db.Generation.findOne({
        where: { publicId: attribution.generationId, projectId },
      })
    : null;

  if (generation) {
    return {
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
    ...(await resolveEndUserAttribution({
      projectId,
      sessionId: attribution.sessionId,
      actorId: attribution.actorId,
    })),
    triggerId: attribution.triggerId ?? null,
    actionId: null,
    source: attribution.source ?? null,
  };
};

type EventComponent = {
  component: string;
  quantity: string | number;
  unit: string;
  unitPrice: string | null;
  costUsd: string | null;
  priceId: number | null;
};

/** The one write of a `tool_execution` event, for outbound and native calls alike. */
const writeToolExecutionEvent = async (args: {
  meter: CallerMeter;
  // A stored tool by its row; a native tool, which has none, by its public id.
  tool: { toolId: number | null } | { toolPublicId: string };
  outcome: ToolExecutionOutcome;
  components: EventComponent[];
}): Promise<void> => {
  const resolved = await resolveAttribution(args.meter);
  const guardrailIds = args.meter.attribution.guardrailIds ?? [];
  // A tool call has no replay identity: a retry is a second call on the wire
  // and meters as one, so the key is unique per execution.
  const idempotencyKey = `tool:${randomUUID()}`;

  await db.sequelize.transaction(async (transaction) => {
    const projectId = eventProjectId(args.meter);
    const [event, created] = await insertUsageEvent({
      defaults: {
        projectId,
        publisherProjectId:
          projectId === args.meter.projectId ? null : args.meter.projectId,
        ...resolved,
        ...args.tool,
        aiProviderId: null,
        outcome: args.outcome,
        guardrailIds: guardrailIds.length > 0 ? [...guardrailIds] : null,
        meterType: TOOL_EXECUTION_METER_TYPE,
        provider: TOOL_PROVIDER,
        model: TOOL_MODEL,
        costUsd: sumComponentCostUsd(
          args.components.map((component) => {
            return component.costUsd;
          })
        ),
        idempotencyKey,
      },
      transaction,
    });
    if (!created || args.components.length === 0) return;

    await db.UsageComponent.bulkCreate(
      args.components.map((component) => {
        return {
          ...component,
          publicId: generatePublicId(PUBLIC_ID_PREFIXES.usageComponent),
          usageEventId: event.id,
          billable: true,
        };
      }),
      { transaction }
    );
  });
};

const persistToolExecution = async (args: {
  meter: ToolExecutionMeter;
  call: ToolCallRecord;
}): Promise<void> => {
  const { toolId } = args.meter;
  const priced = toolId
    ? await priceToolResource({
        toolId,
        ownerProjectId: args.meter.projectId,
        call: args.call,
      })
    : { components: [], invalid: [] };
  await writeToolExecutionEvent({
    meter: args.meter,
    // The tool lives in its own project, not the caller's.
    tool: {
      toolId: await internalId({
        model: 'Tool',
        projectId: args.meter.projectId,
        publicId: toolId,
      }),
    },
    outcome: args.call.outcome as ToolExecutionOutcome,
    components: [
      {
        component: TOOL_COMPONENT,
        quantity: '1',
        unit: TOOL_COMPONENT,
        unitPrice: null,
        costUsd: null,
        priceId: null,
      },
      ...priced.components,
    ],
  });
  await reportInvalidQuantities({
    projectId: eventProjectId(args.meter),
    invalid: priced.invalid,
  });
};

/**
 * Runs one outbound tool call and writes its `tool_execution` event.
 *
 * `send` calls `markSent` the moment the request leaves, with what it sent: a
 * call refused before that (an egress block, an unresolvable template) is not
 * an execution and writes nothing, while one that went out is recorded
 * whatever the target answered. The write is awaited so a guardrail counting
 * this tool's calls sees it on the next call, and never throws: metering must
 * not fail the call it measures.
 */
export const meterToolExecution = async <T>(args: {
  meter: ToolExecutionMeter;
  send: (markSent: (sent?: SentToolCall) => void) => Promise<T>;
}): Promise<T> => {
  log('meterToolExecution: tool=%s', args.meter.toolId);
  const { sender } = args.meter;
  if (!sender.caller && !sender.authority) {
    throw workAuthorityMissing({
      work: `The call to tool '${args.meter.toolId ?? 'inline'}'`,
    });
  }
  const startedAt = Date.now();
  const sent: { call?: SentToolCall } = {};
  let outcome: ToolExecutionOutcome = 'ok';
  let response: unknown = null;
  try {
    const result = await args.send((call) => {
      sent.call = call ?? {};
    });
    response = result;
    return result;
  } catch (error) {
    outcome = isTimeoutError({ error }) ? 'timeout' : 'error';
    throw error;
  } finally {
    if (sent.call) {
      try {
        await persistToolExecution({
          meter: args.meter,
          call: {
            ...sent.call,
            response,
            outcome,
            durationMs: Date.now() - startedAt,
          },
        });
      } catch (error) {
        reportLostUsageEvent({
          recorder: 'meterToolExecution',
          detail: `tool=${args.meter.toolId}`,
          error,
        });
      }
    }
  }
};

/** A native tool's meter: the tool has no row and is never another project's. */
export type NativeToolExecutionMeter = {
  projectId: number;
  /** `native:<name>`, the id its proposals and guardrail context carry. */
  toolId: string;
  attribution: ToolCallAttribution;
};

/**
 * Runs one native (in-process) tool call and writes its `tool_execution`
 * event, unpriced. `run` calls `markExecuted` when the side effect starts: a
 * call refused before that writes nothing, as an outbound call refused before
 * it is sent.
 */
export const meterNativeToolExecution = async <T>(args: {
  meter: NativeToolExecutionMeter;
  run: (markExecuted: () => void) => Promise<T>;
}): Promise<T> => {
  log('meterNativeToolExecution: tool=%s', args.meter.toolId);
  let executed = false;
  let outcome: ToolExecutionOutcome = 'ok';
  try {
    return await args.run(() => {
      executed = true;
    });
  } catch (error) {
    outcome = isTimeoutError({ error }) ? 'timeout' : 'error';
    throw error;
  } finally {
    if (executed) {
      try {
        await writeToolExecutionEvent({
          meter: args.meter,
          tool: { toolPublicId: args.meter.toolId },
          outcome,
          components: [],
        });
      } catch (error) {
        reportLostUsageEvent({
          recorder: 'meterNativeToolExecution',
          detail: `tool=${args.meter.toolId}`,
          error,
        });
      }
    }
  }
};
