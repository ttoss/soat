/**
 * Auto-files exceptions by subscribing to events the platform already emits,
 * so producers stay decoupled: an exhausted run and a lapsed approval reuse
 * the existing `orchestration_runs.failed` / `approvals.expired` events with
 * no change to those modules; a guardrail tripwire emits a dedicated
 * `guardrail.tripwire` event. Every handler is fire-and-forget — a filing
 * failure must never disturb the producer.
 *
 * Split out of `exceptions.ts`, which carries the CRUD/query half of the
 * module and was at the `max-lines` limit; this half shares nothing with that
 * one but the `fileException` writer, which is why it can leave (mirrors how
 * `agentDelete.ts` split from `agents.ts`).
 */
import {
  emitResourceEvent,
  onEvent,
  retryOrRecordDrop,
  type SoatEvent,
} from './eventBus';
import { fileException } from './exceptions';
import { isSoatEventType, type SoatEventType } from './soatEvents';

const asRecord = (value: unknown): Record<string, unknown> => {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
};

const asStringOrNull = (value: unknown): string | null => {
  return typeof value === 'string' ? value : null;
};

const fileRunFailedException = async (event: SoatEvent): Promise<void> => {
  const orchestrationRunId = event.resourceId;
  await fileException({
    projectId: event.projectId,
    kind: 'run_failed',
    title: `Orchestration run ${orchestrationRunId} failed`,
    detail: asRecord(event.data).error
      ? asRecord(asRecord(event.data).error)
      : null,
    orchestrationRunId,
    // One exception per failed run — a run reaches `failed` once.
    dedupKey: `run_failed:${orchestrationRunId}`,
  });
};

const fileApprovalExpiredException = async (
  event: SoatEvent
): Promise<void> => {
  const approval = asRecord(asRecord(event.data).approval);
  const approvalId = asStringOrNull(approval.id);
  await fileException({
    projectId: event.projectId,
    kind: 'approval_expired',
    title: `Approval ${approvalId ?? '(unknown)'} expired without a decision`,
    detail: {
      approvalId,
      toolId: asRecord(approval.proposed_action).tool_id,
    },
    orchestrationRunId: asStringOrNull(approval.orchestration_run_id),
    agentId: asStringOrNull(approval.agent_id),
    dedupKey: approvalId ? `approval_expired:${approvalId}` : null,
  });
};

const fileGuardrailTripwireException = async (
  event: SoatEvent
): Promise<void> => {
  const data = asRecord(event.data);
  const orchestrationRunId = asStringOrNull(data.orchestrationRunId);
  const nodeId = asStringOrNull(data.nodeId);
  const agentId = asStringOrNull(data.agentId);
  const toolName = asStringOrNull(data.toolName) ?? event.resourceId;
  const guardrailVersion = asStringOrNull(data.guardrailVersion);
  // Fold repeated trips of the same guardrail on the same call site (a tool
  // node that trips every attempt, an agent looping) into one open item.
  // The run path keys on `orchestrationRunId:nodeId`, which is stable across retries of the
  // same node. The non-run path must key on the call site (`agentId:toolName`)
  // rather than `generationId` — every generation gets a fresh id, so keying
  // on it would make dedup impossible for the exact "agent looping" case this
  // fold exists to handle.
  const scope = orchestrationRunId
    ? `${orchestrationRunId}:${nodeId ?? ''}`
    : `${agentId ?? ''}:${toolName}`;
  await fileException({
    projectId: event.projectId,
    kind: 'guardrail_tripwire',
    title: `Guardrail tripwire aborted ${toolName}`,
    detail: {
      toolName,
      action: asStringOrNull(data.action),
      guardrailVersion,
    },
    orchestrationRunId,
    nodeId,
    agentId,
    guardrailVersion,
    dedupKey: `guardrail_tripwire:${scope}:${guardrailVersion ?? ''}`,
  });
};

/**
 * The events that auto-file an exception, keyed by name. A `Map` rather than an
 * object literal so the keys stay typed as registered event names: the
 * subscription below is derived from them, so a renamed event is a compile error
 * here instead of a filer that quietly stops firing.
 */
const EXCEPTION_FILERS = new Map<
  SoatEventType,
  (event: SoatEvent) => Promise<void>
>([
  ['orchestration_runs.failed', fileRunFailedException],
  ['approvals.expired', fileApprovalExpiredException],
  ['guardrail.tripwire', fileGuardrailTripwireException],
]);

const handleEvent = (event: SoatEvent): void => {
  const filer = isSoatEventType(event.type)
    ? EXCEPTION_FILERS.get(event.type)
    : undefined;
  if (!filer) return;
  // Was a bare `.catch(log)`, so a blip on the insert silently dropped the
  // auto-filed exception with nothing left to retry it (#1130).
  retryOrRecordDrop({
    stage: 'exception_file',
    label: 'handleEvent.fileException',
    event,
    operation: () => {
      return filer(event);
    },
  });
};

/**
 * Subscribes the exceptions module to the platform event bus so failures and
 * anomalies auto-file. Wired once at startup from `app.ts`, mirroring the
 * webhook dispatcher.
 */
export const initializeExceptionsListener = (): void => {
  onEvent({ types: [...EXCEPTION_FILERS.keys()], handler: handleEvent });
};

/**
 * Emits a `guardrail.tripwire` event the exceptions listener turns into a
 * `guardrail_tripwire` exception. Fire-and-forget from the guardrail dispatch
 * path — mirrors how audit records are persisted there.
 */
export const emitGuardrailTripwireEvent = (args: {
  projectId: number;
  projectPublicId: string;
  toolId: string | null;
  toolName: string;
  action: string;
  guardrailVersion: string | null;
  orchestrationRunId?: string | null;
  nodeId?: string | null;
  agentId?: string | null;
  generationId?: string | null;
}): void => {
  emitResourceEvent({
    type: 'guardrail.tripwire',
    projectId: args.projectId,
    projectPublicId: args.projectPublicId,
    resourceType: 'guardrail',
    resourceId: args.toolId ?? args.toolName,
    data: {
      toolName: args.toolName,
      action: args.action,
      guardrailVersion: args.guardrailVersion,
      orchestrationRunId: args.orchestrationRunId ?? null,
      nodeId: args.nodeId ?? null,
      agentId: args.agentId ?? null,
      generationId: args.generationId ?? null,
    },
  });
};
