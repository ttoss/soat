import type { db } from '../db';
import type { MappedMemoryAssertion } from './memoryAssertions';
import type { UsageTotals } from './usageTotals';

export type PersistedGeneration = {
  id: string;
  project_id: string;
  agent_id: string;
  trace_id: string;
  initiator_generation_id: string | null;
  chain_id: string | null;
  conversation_id: string | null;
  session_id: string | null;
  actor_id: string | null;
  started_by_principal_type: string | null;
  started_by_principal_id: string | null;
  status: string;
  started_at: Date;
  completed_at: Date | null;
  last_activity_at: Date | null;
  stop_reason: string | null;
  error: Record<string, unknown> | null;
  action_id: string | null;
  trigger_id: string | null;
  orchestration_run_id: string | null;
  node_id: string | null;
  node_attempt: number | null;
  agent_version: number | null;
  source: string | null;
  routing: Record<string, unknown> | null;
  extraction: Record<string, unknown> | null;
  /**
   * The memory writes this turn made, as rows. Present on the single read,
   * absent from the listing — a page of generations would be a page of extra
   * queries. It is what the `extraction` counts summarize, so the two can be
   * reconciled instead of taken on trust.
   */
  memory_assertions?: MappedMemoryAssertion[];
  /**
   * What the turn cost. Present on the single read, absent from the listing:
   * it is a second query per generation, and a page of them would be a page of
   * queries. Undefined is "not asked for"; null is "asked for, nothing metered
   * yet" — a turn still in flight, or one whose metering failed.
   */
  usage?: UsageTotals | null;
  tool_surface: Record<string, unknown> | null;
  idempotency_key: string | null;
  metadata: Record<string, unknown> | null;
  content_redacted_at: Date | null;
  content_redacted_by_principal_type: string | null;
  content_redacted_by_principal_id: string | null;
  created_at: Date;
  updated_at: Date;
};

/**
 * A linked row's public id, or null when the link is absent.
 *
 * Five associations read the same way, and spelling `?.publicId ?? null` at
 * each of them costs the mapper its complexity budget.
 */
const linkedPublicId = (
  linked?: { publicId: string } | null
): string | null => {
  return linked?.publicId ?? null;
};

export const mapGeneration = (
  gen: InstanceType<(typeof db)['Generation']> & {
    project?: InstanceType<(typeof db)['Project']>;
    agent?: InstanceType<(typeof db)['Agent']>;
    trace?: InstanceType<(typeof db)['Trace']>;
    initiatorGeneration?: InstanceType<(typeof db)['Generation']> | null;
    session?: InstanceType<(typeof db)['Session']> | null;
    startedByActor?: InstanceType<(typeof db)['Actor']> | null;
    conversation?: InstanceType<(typeof db)['Conversation']> | null;
  }
): PersistedGeneration => {
  if (!gen.project || !gen.agent || !gen.trace) {
    throw new Error('Generation associations are required for serialization.');
  }

  return {
    id: gen.publicId,
    project_id: gen.project.publicId,
    agent_id: gen.agent.publicId,
    trace_id: gen.trace.publicId,
    initiator_generation_id: linkedPublicId(gen.initiatorGeneration),
    // The continuation chain this turn belongs to; null when it is not one. The
    // chain's own key (`rootGenerationId`) stays internal — this is the handle.
    chain_id: gen.chainId,
    // The conversation this turn served, null everywhere else. Persisted on the
    // generation, so neither side has to be found through the other.
    conversation_id: linkedPublicId(gen.conversation),
    // The end-user attribution the usage event copies at metering time. Exposed
    // here too, because a session's spend is otherwise reconstructable only by
    // recording the session -> generation link outside the platform.
    session_id: linkedPublicId(gen.session),
    actor_id: linkedPublicId(gen.startedByActor),
    started_by_principal_type: gen.startedByPrincipalType,
    started_by_principal_id: gen.startedByPrincipalId,
    status: gen.status,
    started_at: gen.startedAt,
    completed_at: gen.completedAt,
    last_activity_at: gen.lastActivityAt,
    stop_reason: gen.stopReason,
    error: gen.error,
    action_id: gen.actionId,
    trigger_id: gen.triggerId,
    orchestration_run_id: gen.orchestrationRunId,
    node_id: gen.nodeId,
    node_attempt: gen.nodeAttempt,
    agent_version: gen.agentVersion,
    // `eval` when an eval run produced this generation; null for production
    // traffic. Part of the attribution skeleton a content purge preserves.
    source: gen.source,
    routing: gen.routing,
    extraction: gen.extraction,
    tool_surface: gen.toolSurface,
    idempotency_key: gen.idempotencyKey,
    // Caller-owned bag, verbatim. `pendingState` has no entry here at all.
    metadata: gen.metadata,
    content_redacted_at: gen.contentRedactedAt,
    content_redacted_by_principal_type: gen.contentRedactedByPrincipalType,
    content_redacted_by_principal_id: gen.contentRedactedByPrincipalId,
    created_at: gen.createdAt,
    updated_at: gen.updatedAt,
  };
};

/**
 * The same record with its usage roll-up attached.
 *
 * A second function rather than an optional argument on `mapGeneration`: the
 * branch cost that mapper its complexity budget, and point-free
 * `rows.map(mapGeneration)` on a listing would otherwise hand it the array
 * index as the roll-up.
 */
export const mapGenerationWithUsage = (
  gen: Parameters<typeof mapGeneration>[0],
  usage: UsageTotals | null,
  memoryAssertions?: MappedMemoryAssertion[]
): PersistedGeneration => {
  return {
    ...mapGeneration(gen),
    usage,
    ...(memoryAssertions === undefined
      ? {}
      : { memory_assertions: memoryAssertions }),
  };
};
