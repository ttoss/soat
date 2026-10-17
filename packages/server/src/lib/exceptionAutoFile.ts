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
import { onEvent, retryOrRecordDrop, type SoatEvent } from './eventBus';
import { fileException } from './exceptions';
import { generations, getGeneration } from './generations';
import { guardrails, mapGuardrail } from './guardrails';
import { emitLoadedRecordEvent } from './recordEvents';
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
  const approval = event.data;
  const approvalId = event.resourceId;
  await fileException({
    projectId: event.projectId,
    kind: 'approval_expired',
    title: `Approval ${approvalId} expired without a decision`,
    detail: {
      approvalId,
      toolId: asRecord(approval.proposed_action).tool_id,
    },
    orchestrationRunId: asStringOrNull(approval.orchestration_run_id),
    agentId: asStringOrNull(approval.agent_id),
    dedupKey: `approval_expired:${approvalId}`,
  });
};

const fileGuardrailTripwireException = async (
  event: SoatEvent
): Promise<void> => {
  const data = asRecord(event.data);
  const orchestrationRunId = asStringOrNull(data.orchestration_run_id);
  const nodeId = asStringOrNull(data.node_id);
  const agentId = asStringOrNull(data.agent_id);
  const toolName = String(data.tool_name);
  const guardrailVersion = `${event.resourceId}@${String(data.guardrail_version)}`;
  // Folds repeated trips on the same call site into one open item. The non-run
  // path must key on `agentId:toolName`, not `generationId` — a fresh id per
  // generation would make dedup impossible for the looping case this exists for.
  const scope = orchestrationRunId
    ? `${orchestrationRunId}:${nodeId}`
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
    dedupKey: `guardrail_tripwire:${scope}:${guardrailVersion}`,
  });
};

const fileChainLimitException = async (event: SoatEvent): Promise<void> => {
  const data = asRecord(event.data);
  const rootGenerationId = event.resourceId;
  const agentId = asStringOrNull(data.refused_agent_id);
  await fileException({
    projectId: event.projectId,
    kind: 'chain_limit',
    title: `Continuation chain ${rootGenerationId} reached its generation budget`,
    detail: {
      rootGenerationId,
      initiatorGenerationId: asStringOrNull(
        data.refused_initiator_generation_id
      ),
      chainSize: asNumberOrNull(data.chain_size),
      limit: asNumberOrNull(data.limit),
      // Which ceiling refused it: the agent's own `max_chain_generations`, or the
      // deployment's `MAX_CONTINUATION_CHAIN_GENERATIONS`. Without it the number
      // alone does not say which knob to turn.
      limitSource: asStringOrNull(data.limit_source),
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
  // auto-filed exception with nothing left to retry it.
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
 * `guardrail_tripwire` exception: `data` is the guardrail that tripped, as
 * `GET` answers it, with the version that governed and the aborted call beside
 * it. Fire-and-forget from the guardrail dispatch path — mirrors how audit
 * records are persisted there.
 */
export const emitGuardrailTripwireEvent = (args: {
  projectId: number;
  projectPublicId: string;
  guardrail: { guardrailId: string; version: number };
  toolId: string | null;
  toolName: string;
  action: string;
  orchestrationRunId?: string | null;
  nodeId?: string | null;
  agentId?: string | null;
  generationId?: string | null;
}): Promise<void> => {
  return emitLoadedRecordEvent({
    type: 'guardrail.tripwire',
    projectId: args.projectId,
    projectPublicId: args.projectPublicId,
    resourceType: 'guardrail',
    resourceId: args.guardrail.guardrailId,
    load: async () => {
      return mapGuardrail(
        await guardrails.getByPublicId({
          id: args.guardrail.guardrailId,
          projectIds: [args.projectId],
        })
      );
    },
    facts: {
      guardrail_version: args.guardrail.version,
      tool_id: args.toolId,
      tool_name: args.toolName,
      action: args.action,
      orchestration_run_id: args.orchestrationRunId ?? null,
      node_id: args.nodeId ?? null,
      agent_id: args.agentId ?? null,
      generation_id: args.generationId ?? null,
    },
  });
};

/**
 * Emits a `generations.chain_limit` event the exceptions listener turns into a
 * `chain_limit` exception: `data` is the chain's root generation, as `GET`
 * answers it, with the budget and the refused continuation beside it.
 * Fire-and-forget from the chain guard, whose caller is usually a background
 * sweep with nothing left to return a refusal to.
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
}): Promise<void> => {
  return emitLoadedRecordEvent({
    type: 'generations.chain_limit',
    projectId: args.projectId,
    projectPublicId: args.projectPublicId,
    resourceType: 'generation',
    resourceId: args.rootGenerationId,
    load: async () => {
      const root = await getGeneration({
        publicId: args.rootGenerationId,
        includeUsage: true,
      });
      if (!root) throw generations.notFound(args.rootGenerationId);
      return root;
    },
    facts: {
      chain_size: args.chainSize,
      limit: args.limit,
      limit_source: args.limitSource,
      refused_agent_id: args.agentId,
      refused_initiator_generation_id: args.initiatorGenerationId,
    },
  });
};
