import type { RetryPolicy } from './workflowsRetryPolicy';

export type { RetryPolicy };

/**
 * Types describing a workflow definition as it is stored (structural keys in
 * camelCase — the case-transform middleware converts the snake_case API
 * contract inbound — while JSON Logic bodies `guard`/`when` and the opaque
 * `payload`/`payloadSchema` bags round-trip verbatim).
 */
export type WorkflowDispatch = {
  kind: 'agent' | 'orchestration' | 'tool';
  agentId?: string;
  orchestrationId?: string;
  /** `tool` dispatch: the tool to call. */
  toolId?: string;
  /**
   * `tool` dispatch: which operation of a multi-operation tool to invoke —
   * the same selector an orchestration `tool` node's `operation_id` is.
   */
  operationId?: string;
  inputMapping?: Record<string, unknown>;
  /**
   * JSON Logic expressions, evaluated over the same `{task, result}` context
   * `on_complete` rules see, written into `task.payload` atomically with the
   * `last_result` column when the dispatch completes. Unlike `last_result`
   * (overwritten on every dispatch), each key here is a named, deterministic
   * cross-hop channel — no model in the path. A write is a raw overwrite of its key;
   * a value written by an earlier pass through a looping state lingers in the
   * payload until the state runs again.
   */
  payloadWrites?: Record<string, unknown>;
};

export type OnCompleteRule = {
  when: unknown;
  transition: string;
};

export type OnEnter = {
  dispatch: WorkflowDispatch;
  retry?: RetryPolicy | null;
  onComplete?: OnCompleteRule[];
  onFailure?: string | null;
};

export type WorkflowState = {
  name: string;
  initial?: boolean;
  terminal?: boolean;
  /** `human` states never dispatch — the task parks until a transition fires. */
  kind?: string;
  /** Seconds parked in this state before the sweeper emits `tasks.stalled`. */
  stalledAfter?: number | null;
  onEnter?: OnEnter | null;
};

export type WorkflowTransition = {
  name: string;
  from: string[];
  to: string;
  guard?: unknown;
  requiresApproval?: boolean;
};
