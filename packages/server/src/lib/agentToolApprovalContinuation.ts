import createDebug from 'debug';

import { db } from '../db';
import { reactsToExpiredApproval } from './agentApprovalExpiry';
import { emitClientToolReHandoff } from './agentClientToolReHandoff';
import { createGeneration } from './agentGeneration';
import {
  type ApprovalResumeHandler,
  type DecisionOutput,
  type MappedApproval,
  registerApprovalResumeHandler,
} from './approvals';
import { expireChainIfSettled } from './generationChains';
import { buildRunAuthHeader } from './orchestrationRunToken';
import { isPlainObject } from './plainObject';
import { sendSessionMessage } from './sessionOperations';
import { callTool } from './tools';

const log = createDebug('soat:approvals');

const errorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

/**
 * Re-mints the continuation's credential from the principal persisted on the
 * generation that proposed the approved call.
 *
 * The approval can sit pending for days, so identity comes from the row, not
 * the resolving request: the approver decided *whether* the action happens, not
 * *as whom*. `undefined` when the chain has no principal or it no longer
 * resolves; self-calls then go out unauthenticated.
 */
const resolveContinuationAuthHeader = async (args: {
  item: MappedApproval;
  projectInternalId: number;
}): Promise<string | undefined> => {
  if (!args.item.generation_id) return undefined;

  const proposing = await db.Generation.findOne({
    where: { publicId: args.item.generation_id },
    attributes: ['startedByPrincipalType', 'startedByPrincipalId'],
  });
  if (!proposing) return undefined;

  return buildRunAuthHeader({
    principalKind: proposing.startedByPrincipalType,
    principalId: proposing.startedByPrincipalId,
    projectId: args.projectInternalId,
    workPublicId: args.item.id,
  });
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
  authHeader?: string;
}): Promise<object | null> => {
  const proposed = args.item.proposed_action;
  if (!proposed?.tool_id) {
    return {
      error:
        'The approved action targets an inline tool and cannot be executed at resolution time.',
    };
  }
  const input = (args.item.edited_arguments ??
    proposed.arguments ??
    {}) as Record<string, unknown>;

  log(
    'executeApprovedAction: id=%s toolId=%s action=%s',
    args.item.id,
    proposed.tool_id,
    proposed.action ?? '(none)'
  );

  const rawResult = await callTool({
    projectIds: [args.projectInternalId],
    id: proposed.tool_id,
    action: proposed.action,
    input,
    // The approved action runs as the chain's principal too, not just the
    // continuation that reports it — a proposed `soat` call is executed here,
    // and without the credential it reaches the loopback unauthenticated.
    authHeader: args.authHeader,
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
  // Always a tool-call item here (guarded upstream), so proposedAction is set;
  // fall back defensively rather than asserting.
  const proposed = item.proposed_action;
  const toolRef = proposed?.action
    ? `${proposed.tool_id} (${proposed.action})`
    : (proposed?.tool_id ?? 'the requested tool');
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
 * Whether this agent wants an expired approval reported back to it.
 *
 * Read off the agent at resume time rather than frozen onto the approval at
 * proposal time: the item can sit pending for days, and what its owner wants
 * applied is the config as it stands now — the same reason the chain budget is
 * read live rather than captured. An agent that no longer exists cannot react,
 * so a missing row terminates.
 */
const reportsExpiryToAgent = async (item: MappedApproval): Promise<boolean> => {
  if (!item.agent_id) return false;
  const agent = await db.Agent.findOne({
    where: { publicId: item.agent_id },
    attributes: ['onApprovalExpiry'],
  });
  return reactsToExpiredApproval(agent?.onApprovalExpiry);
};

/**
 * Records a terminal expiry on the chain the lapsed call belonged to, when it
 * belonged to one. A chain whose *root* held the call has no row — chains are
 * created by the first continuation — so this only fires for a chain that had
 * already grown, which is exactly the case where "it ended on a deadline" is
 * worth distinguishing from "it finished".
 */
const recordChainExpiry = async (item: MappedApproval): Promise<void> => {
  if (!item.generation_id) return;
  const generation = await db.Generation.findOne({
    where: { publicId: item.generation_id },
    attributes: ['rootGenerationId'],
  });
  if (!generation?.rootGenerationId) return;
  await expireChainIfSettled({
    rootGenerationId: generation.rootGenerationId,
  });
};

/**
 * Fires the continuation generation that closes the return-pending loop (§4.2),
 * feeding the decision back into the agent's context. Two paths:
 *
 * - **Session-backed**: the continuation appends to the originating session's
 *   thread via `sendSessionMessage`, so provenance flows through the shared
 *   conversation, and `initiator_generation_id` rides the session generation
 *   stack so the turn joins the same bounded chain as the standalone branch.
 * - **Standalone**: a new generation linked to the original via
 *   `initiator_generation_id`.
 */
const fireContinuation = async (args: {
  item: MappedApproval;
  decision: DecisionOutput;
  projectInternalId: number;
  authHeader?: string;
}): Promise<void> => {
  const { item } = args;
  if (!item.agent_id) return;

  const message = buildContinuationMessage({ item, decision: args.decision });

  if (item.session_id) {
    const agent = await db.Agent.findOne({
      where: { publicId: item.agent_id },
    });
    if (!agent) return;
    log('fireContinuation: session id=%s session=%s', item.id, item.session_id);
    await sendSessionMessage({
      agentId: agent.id as number,
      sessionId: item.session_id,
      message,
      authHeader: args.authHeader,
      initiatorGenerationId: item.generation_id,
    });
    return;
  }

  log('fireContinuation: standalone id=%s', item.id);
  await createGeneration({
    agentId: item.agent_id,
    projectIds: [args.projectInternalId],
    initiatorGenerationId: item.generation_id,
    messages: [{ role: 'user', content: message }],
    // Carries the chain's identity into the continuation's own `soat` tools,
    // and — because `createGeneration` reads the principal back off it — onto
    // the continuation's generation row, so a further approval in the same
    // chain re-mints from there in turn.
    authHeader: args.authHeader,
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
  if (!item.project_id) return;

  try {
    const project = await db.Project.findOne({
      where: { publicId: item.project_id },
    });
    if (!project) {
      log('runToolCallContinuation: project not found id=%s', item.id);
      return;
    }
    const projectInternalId = project.id as number;

    const authHeader = await resolveContinuationAuthHeader({
      item,
      projectInternalId,
    });

    let result: object | null = null;
    if (args.decision.decision === 'approved') {
      // A client tool cannot run server-side, so approval re-hands the call off
      // via a fresh linked generation and there is no server-side result or NL
      // continuation — the client resumes the loop itself.
      const reHandedOff = await emitClientToolReHandoff({
        item,
        projectInternalId,
        authHeader,
      });
      if (reHandedOff) return;

      result = await executeApprovedAction({
        item,
        projectInternalId,
        authHeader,
      }).catch((error: unknown) => {
        log('executeApprovedAction failed id=%s %o', item.id, error);
        return { error: errorMessage(error) };
      });
    }

    // An expiry means nobody was at the wheel, so by default there is nobody to
    // report to and nothing a turn would add: the `expired` row, the
    // `approvals.expired` event and the auto-filed exception are already the
    // whole record. Continuing instead is what compounded #1161 — under a
    // forcing `tool_choice` the reported-to turn can only propose more gated
    // calls, which expire, which continue again.
    if (
      args.decision.decision === 'expired' &&
      !(await reportsExpiryToAgent(item))
    ) {
      log('runToolCallContinuation: expiry is terminal id=%s', item.id);
      await recordChainExpiry(item);
      return;
    }

    await fireContinuation({
      item,
      decision: { ...args.decision, result },
      projectInternalId,
      authHeader,
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
