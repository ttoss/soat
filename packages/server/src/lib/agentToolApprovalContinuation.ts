import createDebug from 'debug';

import { db } from '../db';
import { createGeneration } from './agentGeneration';
import {
  type ApprovalResumeHandler,
  type DecisionOutput,
  type MappedApproval,
  registerApprovalResumeHandler,
} from './approvals';
import { sendSessionMessage } from './sessionOperations';
import { callTool } from './tools';

const log = createDebug('soat:approvals');

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const errorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

/**
 * Executes the frozen (or edited) proposed action at resolution time and returns
 * its output as the decision `result`. Runs through the normal persisted-tool
 * path (`callTool`), which re-applies preset parameters and output mapping.
 * Inline-tool proposals have no persisted id to execute against, so they carry a
 * structured note instead of a result.
 */
const executeApprovedAction = async (args: {
  item: MappedApproval;
  projectInternalId: number;
}): Promise<object | null> => {
  const proposed = args.item.proposedAction;
  if (!proposed?.toolId) {
    return {
      error:
        'The approved action targets an inline tool and cannot be executed at resolution time.',
    };
  }
  const input = (args.item.editedArguments ??
    proposed.arguments ??
    {}) as Record<string, unknown>;

  log(
    'executeApprovedAction: id=%s toolId=%s action=%s',
    args.item.id,
    proposed.toolId,
    proposed.action ?? '(none)'
  );

  const rawResult = await callTool({
    projectIds: [args.projectInternalId],
    id: proposed.toolId,
    action: proposed.action,
    input,
  });

  return isPlainObject(rawResult) ? rawResult : { output: rawResult };
};

/**
 * A single natural-language summary of the decision, fed back to the agent as
 * the continuation's opening message so it can finish what it proposed. The
 * structured decision (approval id, executed result, rejection reason) is
 * embedded for the model to reason over.
 */
const buildContinuationMessage = (args: {
  item: MappedApproval;
  decision: DecisionOutput;
}): string => {
  const { item, decision } = args;
  const toolRef = item.proposedAction.action
    ? `${item.proposedAction.toolId} (${item.proposedAction.action})`
    : item.proposedAction.toolId;
  const parts = [
    `Approval ${decision.approvalId} for your proposed call to tool ${toolRef} was ${decision.decision}.`,
  ];
  if (decision.editedArgs) {
    parts.push(
      `It was approved with edited arguments: ${JSON.stringify(decision.editedArgs)}.`
    );
  }
  if (decision.decision === 'approved') {
    parts.push(
      `The action has been executed. Result: ${JSON.stringify(decision.result)}.`
    );
  } else if (decision.decision === 'rejected') {
    parts.push(
      `Nothing was executed. Reason: ${decision.reason ?? 'no reason given'}.`
    );
  } else {
    parts.push(
      'It expired before a human decided, so nothing was executed. Do not silently retry; report the staleness.'
    );
  }
  return parts.join(' ');
};

/**
 * Fires the continuation generation that closes the return-pending loop (§4.2),
 * feeding the decision back into the agent's context. Two paths:
 *
 * - **Session-backed**: the continuation appends to the originating session's
 *   thread via `sendSessionMessage`, so provenance flows through the shared
 *   conversation. (Threading `initiator_generation_id` through the session
 *   generation stack is a follow-up; the thread linkage is the provenance today.)
 * - **Standalone**: a new generation linked to the original via
 *   `initiator_generation_id`.
 */
const fireContinuation = async (args: {
  item: MappedApproval;
  decision: DecisionOutput;
  projectInternalId: number;
}): Promise<void> => {
  const { item } = args;
  if (!item.agentId) return;

  const message = buildContinuationMessage({ item, decision: args.decision });

  if (item.sessionId) {
    const agent = await db.Agent.findOne({ where: { publicId: item.agentId } });
    if (!agent) return;
    log('fireContinuation: session id=%s session=%s', item.id, item.sessionId);
    await sendSessionMessage({
      agentId: agent.id as number,
      sessionId: item.sessionId,
      message,
    });
    return;
  }

  log('fireContinuation: standalone id=%s', item.id);
  await createGeneration({
    agentId: item.agentId,
    projectIds: [args.projectInternalId],
    initiatorGenerationId: item.generationId,
    messages: [{ role: 'user', content: message }],
  });
};

/**
 * Runs the full tool-call continuation for a resolved item: execute the approved
 * action (populating the decision `result`), then fire the continuation
 * generation. Self-contained — it never rejects, so the resume handler can fire
 * it and forget it without an unhandled rejection. Exported so tests can await
 * it deterministically.
 */
export const runToolCallContinuation = async (args: {
  item: MappedApproval;
  decision: DecisionOutput;
}): Promise<void> => {
  const { item } = args;
  if (item.origin !== 'tool_call') return;
  if (!item.projectId) return;

  try {
    const project = await db.Project.findOne({
      where: { publicId: item.projectId },
    });
    if (!project) {
      log('runToolCallContinuation: project not found id=%s', item.id);
      return;
    }
    const projectInternalId = project.id as number;

    let result: object | null = null;
    if (args.decision.decision === 'approved') {
      result = await executeApprovedAction({ item, projectInternalId }).catch(
        (error: unknown) => {
          log('executeApprovedAction failed id=%s %o', item.id, error);
          return { error: errorMessage(error) };
        }
      );
    }

    await fireContinuation({
      item,
      decision: { ...args.decision, result },
      projectInternalId,
    });
  } catch (error) {
    // The continuation is best-effort: the decision is already persisted and
    // its webhook emitted. A failure here (e.g. the proposing agent was since
    // deleted) is logged, never thrown — the resolve request must not fail.
    log('runToolCallContinuation failed id=%s %o', item.id, error);
  }
};

/**
 * The tool-call producer's resumption callback (§1). Registered alongside the
 * `approval` node's handler; each guards on `origin` so only its own items are
 * handled. Kicks the continuation off fire-and-forget so the resolve request
 * (approve/reject) returns promptly — the decision is already persisted and its
 * lifecycle webhook already emitted, matching the manage-by-exception model
 * ("the agent proposed; you'll be notified when it executes"). Safe without a
 * `.catch` because {@link runToolCallContinuation} never rejects.
 */
export const resumeToolCallApproval: ApprovalResumeHandler = async ({
  item,
  decision,
}) => {
  if (item.origin !== 'tool_call') return;
  void runToolCallContinuation({ item, decision });
};

registerApprovalResumeHandler(resumeToolCallApproval);
