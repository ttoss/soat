import type { GuardrailEvaluationRecord } from './guardrailEvaluationRecord';

/**
 * The shared vocabulary of node execution: what a node hands back, and what the
 * engine persists when a node parks the run.
 *
 * Their own module on purpose. They used to sit next to the eight
 * implementations in `orchestrationNodeExecutors.ts`, which forced every
 * per-node-type file to import that module for a type while the module imported
 * them back — five of the six import cycles #910 found existed only for that.
 * A module that declares types and imports nothing but types cannot be in a
 * cycle.
 *
 * Nothing here executes anything; see `orchestrationNodeDispatch.ts`.
 */

/**
 * The frozen proposal an `approval` node hands to the engine, which emits it as
 * an ApprovalItem (linked to the parked run) when the run settles.
 */
export type ApprovalNodeSpec = {
  toolId: string;
  arguments: Record<string, unknown>;
  reasoning: string | null;
  evidence: object | null;
  predictedImpact: string | null;
  expiresInSeconds: number;
  // `${guardrailId}@${version}` of the guardrail that routed this proposal to
  // approval, or null for an explicit (non-guardrail) `approval` node.
  policyVersion: string | null;
  // The guardrail_evaluation records for this proposal, persisted by the
  // engine once the ApprovalItem exists so they can be cross-linked via
  // `approvalId`. Absent for an explicit `approval` node (no evaluations ran).
  guardrailEvaluationRecords?: GuardrailEvaluationRecord[];
};

/**
 * Describes how a scheduled `wait` should be resumed once its timer elapses.
 * `delay` carries the artifact the delay node produces (the wait is a pure
 * timer, so on resume the node is simply recorded as complete). `poll` carries
 * the next attempt number, so the poll node re-executes from where it left off.
 */
export type WaitResume =
  | { kind: 'delay'; artifact: Record<string, unknown> }
  | { kind: 'poll'; attempt: number }
  | { kind: 'retry'; attempt: number };

export type NodeExecutionResult =
  | { kind: 'artifact'; artifact: Record<string, unknown>; traceId?: string }
  | { kind: 'condition'; label: string }
  | {
      // A routable outcome, not a run failure: the node is treated like a
      // decision node, so an unlabeled happy-path edge does not auto-follow a
      // blocked action.
      kind: 'blocked';
      nodeId: string;
      label: 'blocked' | 'tripwire';
      artifact: Record<string, unknown>;
    }
  | {
      kind: 'requires_action';
      type: 'human_input' | 'webhook_receive' | 'approval';
      nodeId: string;
      prompt: string;
      context: Record<string, unknown>;
      options?: string[];
      // Present only for `approval` requires_action: the frozen proposal the
      // engine emits as an ApprovalItem when the run parks (§5b of the PRD).
      approvalSpec?: ApprovalNodeSpec;
    }
  | {
      // Offloads a long wait to the background scheduler instead of holding
      // the run loop, and its HTTP request, open.
      kind: 'wait';
      nodeId: string;
      resumeInMs: number;
      resume: WaitResume;
    };

export type RequiredAction = {
  type: 'human_input' | 'webhook_receive' | 'approval';
  nodeId: string;
  prompt: string;
  context: Record<string, unknown>;
  options?: string[];
  // `approvalSpec` is the frozen proposal emitted as an ApprovalItem at settle
  // time; the ids are stamped back on so the persisted `required_action`
  // exposes the created item to callers.
  approvalSpec?: ApprovalNodeSpec;
  approvalId?: string;
  expiresAt?: string;
};

/**
 * A node that paused the run to wait for a timer (delay) or the interval
 * between poll attempts. The engine persists this so the background scheduler
 * can resume the run from `nodeId` once `resumeInMs` has elapsed.
 */
export type ScheduledWait = {
  nodeId: string;
  resumeInMs: number;
  resume: WaitResume;
};
