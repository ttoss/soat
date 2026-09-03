/**
 * Auto-files exceptions by subscribing to events the platform already emits,
 * so producers stay decoupled: an exhausted run and a lapsed approval reuse
 * the existing `orchestration_runs.failed` / `approvals.expired` events with
 * no change to those modules; a guardrail tripwire and a refused continuation
 * chain emit dedicated `guardrail.tripwire` / `generations.chain_limit`
 * events. Every handler is fire-and-forget — a filing
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

const asNumberOrNull = (value: unknown): number | null => {
  return typeof value === 'number' ? value : null;
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
  // Folds repeated trips on the same call site into one open item. The non-run
  // path must key on `agentId:toolName`, not `generationId` — a fresh id per
  // generation would make dedup impossible for the looping case this exists for.
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

const fileChainLimitException = async (event: SoatEvent): Promise<void> => {
  const data = asRecord(event.data);
  const rootGenerationId = event.resourceId;
  const agentId = asStringOrNull(data.agentId);
  await fileException({
    projectId: event.projectId,
    kind: 'chain_limit',
    title: `Continuation chain ${rootGenerationId} reached its generation budget`,
    detail: {
      rootGenerationId,
      initiatorGenerationId: asStringOrNull(data.initiatorGenerationId),
      chainSize: asNumberOrNull(data.chainSize),
      limit: asNumberOrNull(data.limit),
      // Which ceiling refused it: the agent's own `max_chain_generations`, or the
      // deployment's `MAX_CONTINUATION_CHAIN_GENERATIONS`. Without it the number
      // alone does not say which knob to turn.
      limitSource: asStringOrNull(data.limitSource),
    },
    agentId,
    // The chain's root, which is the one id every refusal in it shares — an
    // over-budget chain refuses once per resumption, so keying on the refused
    // hop would file an item per occurrence of exactly the runaway this
    // exists to report.
    dedupKey: `chain_limit:${rootGenerationId}`,
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
  ['generations.chain_limit', fileChainLimitException],
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

/**
 * Emits a `generations.chain_limit` event the exceptions listener turns into a
 * `chain_limit` exception. Fire-and-forget from the chain guard, whose caller is
 * usually a background sweep with nothing left to return a refusal to.
 */
export const emitChainLimitEvent = (args: {
  projectId: number;
  projectPublicId: string;
  agentId: string;
  rootGenerationId: string;
  initiatorGenerationId: string | null;
  chainSize: number;
  limit: number;
  limitSource: 'agent' | 'project' | 'platform';
}): void => {
  emitResourceEvent({
    type: 'generations.chain_limit',
    projectId: args.projectId,
    projectPublicId: args.projectPublicId,
    resourceType: 'generation',
    resourceId: args.rootGenerationId,
    data: {
      agentId: args.agentId,
      initiatorGenerationId: args.initiatorGenerationId,
      chainSize: args.chainSize,
      limit: args.limit,
      limitSource: args.limitSource,
    },
  });
};
