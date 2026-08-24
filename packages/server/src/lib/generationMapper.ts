import type { db } from '../db';

export type PersistedGeneration = {
  id: string;
  project_id: string;
  agent_id: string;
  trace_id: string;
  initiator_generation_id: string | null;
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
  metadata: Record<string, unknown> | null;
  content_redacted_at: Date | null;
  content_redacted_by_principal_type: string | null;
  content_redacted_by_principal_id: string | null;
  created_at: Date;
  updated_at: Date;
};

export const mapGeneration = (
  gen: InstanceType<(typeof db)['Generation']> & {
    project?: InstanceType<(typeof db)['Project']>;
    agent?: InstanceType<(typeof db)['Agent']>;
    trace?: InstanceType<(typeof db)['Trace']>;
    initiatorGeneration?: InstanceType<(typeof db)['Generation']> | null;
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
    initiator_generation_id: gen.initiatorGeneration?.publicId ?? null,
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
    // Caller-owned bag, verbatim. `pendingState` has no entry here at all.
    metadata: gen.metadata,
    content_redacted_at: gen.contentRedactedAt,
    content_redacted_by_principal_type: gen.contentRedactedByPrincipalType,
    content_redacted_by_principal_id: gen.contentRedactedByPrincipalId,
    created_at: gen.createdAt,
    updated_at: gen.updatedAt,
  };
};
