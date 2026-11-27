import type { AuthUser } from 'src/Context';

import type { GenerationIds } from './agentGenerationTypes';
import type { GenerationConversation } from './generationAttribution';
import type { GenerationIdempotency } from './generationIdempotency';
import type { GenerationInputMessage } from './generationInputMessages';
import type { WorkAuthority } from './workAuthority';

/** What a caller passes to start an agent generation (`createGeneration`). */
export type CreateGenerationArgs = {
  projectIds?: number[];
  // The project the turn runs and is recorded in, when the caller knows it;
  // the agent is then that project's own or one shared with it.
  runProjectId?: number;
  agentId: string;
  messages: GenerationInputMessage[];
  stream?: boolean;
  traceId?: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  initiatorGenerationId?: string | null;
  remainingDepth?: number;
  authority: WorkAuthority | null;
  authUser?: AuthUser;
  toolContext?: Record<string, string>;
  abortSignal?: AbortSignal;
  knowledgeConfig?: object;
  citationConfig?: object;
  actionId?: string;
  triggerId?: string;
  orchestrationRunId?: string;
  nodeId?: string;
  // The orchestration node's 1-based retry attempt, completing the
  // run + node + attempt replay identity. Absent outside an orchestration node.
  nodeAttempt?: number;
  // End-user attribution: the session this generation runs in, from which the
  // actor is derived. Set by the session path; absent for direct API
  // generations, triggers, and orchestration nodes — no end user behind them.
  sessionId?: string;
  // An actor with no session, validated by the entry point that names it
  // (`assertCallerEndUser`); ignored beside a session. Set by ingestion.
  actorId?: string;
  // The conversation this turn answers, set by the conversation path only.
  conversation?: GenerationConversation;
  metadata?: Record<string, unknown> | null;
  // Caller-supplied guardrail context (guardrails.md — Guards and Guardrail
  // Context); the `context.*` namespace guards read at tool-dispatch time.
  guardrailContext?: Record<string, unknown> | null;
  // Forces one archived agent version instead of letting release assignment
  // pick per generation. Set by eval runs, which must measure every item
  // against the same config (the evaluations module doc — Version pinning).
  pinnedAgentVersion?: number | null;
  // Copied onto the usage event at the metering choke point, so verification
  // spend stays separable from production spend.
  source?: string | null;
  // Written only by `claimKeyedGeneration`, which checks the key first.
  idempotency?: GenerationIdempotency;
  // The schema a decider's question set compiles to. Internal only: no route
  // reads a per-call schema, so a call site cannot widen what an agent answers.
  outputSchemaOverride?: Record<string, unknown>;
  // Overrides the agent's `timezone` for this turn's instruction tokens.
  timezone?: unknown;
  // Called once the record exists and before the provider is, so a caller
  // blocked on the turn can name it while it runs. Internal only.
  onRecorded?: (args: GenerationIds) => Promise<void> | void;
};
