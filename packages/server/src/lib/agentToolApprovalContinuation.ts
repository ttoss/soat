import createDebug from 'debug';

import { db } from '../db';
import { reactsToExpiredApproval } from './agentApprovalExpiry';
import { type AgentAuthority, resolveAgentAuthority } from './agentAuthority';
import { emitClientToolReHandoff } from './agentClientToolReHandoff';
import { createGeneration } from './agentGeneration';
import {
  runApprovedWriteMemory,
  WRITE_MEMORY_TOOL_ID,
  writeMemoryEditChecks,
} from './agentKnowledge';
import { isInlineProposal, isNativeProposal } from './agentToolApproval';
import {
  type ApprovalResumeHandler,
  type DecisionOutput,
  type MappedApproval,
  registerApprovalResumeHandler,
} from './approvals';
import { expireChainIfSettled } from './generationChains';
import type { PolicyDocument } from './iam';
import { isPlainObject } from './plainObject';
import { agentReferences } from './resourceReferences';
import { sendSessionMessage } from './sessionOperations';
import { callTool } from './tools';
import {
  forWork,
  parseWorkAuthority,
  type WorkAuthority,
} from './workAuthority';

const log = createDebug('soat:approvals');

const errorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

/**
 * The continuation's authority: the one the generation that proposed the
 * approved call stores. The approval can sit pending for days, so it comes
 * from the row, not the resolving request: the approver decided *whether* the
 * action happens, not *as whom*. Null when there is no proposing generation.
 */
const resolveContinuationAuthority = async (args: {
  item: MappedApproval;
}): Promise<WorkAuthority | null> => {
  if (!args.item.generation_id) return null;
  const proposing = await db.Generation.findOne({
    where: { publicId: args.item.generation_id },
    attributes: ['authority'],
  });
  const authority = parseWorkAuthority(proposing?.authority);
  return authority ? forWork({ authority, work: args.item.id }) : null;
};

/** Refuses every action: what an agent that no longer resolves is bounded by. */
const DENY_ALL_POLICY: PolicyDocument = {
  statement: [{ effect: 'Deny', action: ['*'], resource: ['*'] }],
};

/** The end user the proposing generation ran for, bound into its policies. */
const proposingActorId = async (
  generationId: string | null | undefined
): Promise<string | null> => {
  if (!generationId) return null;
  const proposing = await db.Generation.findOne({
    where: { publicId: generationId },
    attributes: ['startedByActorId'],
    include: [
      { model: db.Actor, as: 'startedByActor', attributes: ['publicId'] },
    ],
  });
  return proposing?.startedByActor?.publicId ?? null;
};

/**
 * The proposing agent's `policy_ids` as they stand now, the same cap the
 * agent's own calls are held to.
 */
const proposingAgentAuthority = async (args: {
  item: MappedApproval;
  projectInternalId: number;
}): Promise<AgentAuthority> => {
  const agent = args.item.agent_id
    ? await agentReferences.find({
        id: args.item.agent_id,
        projectId: args.projectInternalId,
        reach: 'project',
      })
    : null;
  if (!agent) {
    return {
      runAs: 'caller',
      agentId: args.item.agent_id ?? null,
      policy: DENY_ALL_POLICY,
    };
  }
  return resolveAgentAuthority({
    agentId: agent.publicId,
    runAs: agent.runAs,
    policyIds: agent.policyIds,
    actorId: await proposingActorId(args.item.generation_id),
    // An approval with no project row left pins the grant to no project.
    projectPublicId: args.item.project_id ?? '',
  });
};

/** The approved `write_memory` call, run as the agent that proposed it. */
const executeApprovedWriteMemory = async (args: {
  item: MappedApproval;
  projectInternalId: number;
  input: Record<string, unknown>;
}): Promise<object> => {
  const agent = args.item.agent_id
    ? await agentReferences.find({
        id: args.item.agent_id,
        projectId: args.projectInternalId,
        reach: 'project',
      })
    : null;
  const actorId = await proposingActorId(args.item.generation_id);
  return runApprovedWriteMemory({
    agent,
    generationId: args.item.generation_id ?? null,
    projectId: args.projectInternalId,
    agentPolicy: (
      await proposingAgentAuthority({
        item: args.item,
        projectInternalId: args.projectInternalId,
      })
    ).policy,
    actorId: actorId ?? undefined,
    input: args.input,
  });
};

type EditCheck = {
  action: string;
  resource: string;
  context?: Record<string, string>;
};

/** Everything resolution needs to know about one native tool, a tool with no row. */
type NativeTool = {
  /** How an approved call runs. */
  execute: typeof executeApprovedWriteMemory;
  /**
   * What an approver must hold, beyond `tools:CallTool`, to edit a held call:
   * the work the call performs in-process, which nothing else checks against
   * the approver.
   */
  editChecks: (args: {
    agentId: string | null;
    projectId: number;
    projectPublicId: string;
  }) => Promise<EditCheck[]>;
};

/**
 * Every native tool, by `tool_id`. One missing here is refused at resolution
 * rather than looked up as a stored tool, so an edit of it adds nothing.
 */
const NATIVE_TOOLS: Record<string, NativeTool | undefined> = {
  [WRITE_MEMORY_TOOL_ID]: {
    execute: executeApprovedWriteMemory,
    editChecks: writeMemoryEditChecks,
  },
};

export const nativeProposalEditChecks = async (args: {
  toolId: string;
  agentId: string | null;
  projectId: number;
  projectPublicId: string;
}): Promise<EditCheck[]> => {
  return (await NATIVE_TOOLS[args.toolId]?.editChecks(args)) ?? [];
};

const executeApprovedNativeAction = async (args: {
  toolId: string;
  item: MappedApproval;
  projectInternalId: number;
  input: Record<string, unknown>;
}): Promise<object> => {
  const nativeTool = NATIVE_TOOLS[args.toolId];
  if (!nativeTool) {
    return {
      error: `The approved action targets ${args.toolId}, which cannot be executed at resolution time.`,
    };
  }
  return nativeTool.execute({
    item: args.item,
    projectInternalId: args.projectInternalId,
    input: args.input,
  });
};

/**
 * Executes the frozen (or edited) proposed action at resolution time and returns
 * its output as the decision `result`. A persisted tool runs through
 * `callTool`, which re-applies preset parameters and output mapping; a native
 * tool runs through its {@link NATIVE_TOOLS} entry. An inline tool has nothing to
 * execute against, so it carries a structured note instead of a result.
 */
const executeApprovedAction = async (args: {
  item: MappedApproval;
  projectInternalId: number;
  authority: WorkAuthority | null;
  toolContext?: Record<string, string>;
}): Promise<object | null> => {
  const proposed = args.item.proposed_action;
  if (!proposed?.tool_id || isInlineProposal(proposed.tool_id)) {
    return {
      error:
        'The approved action targets an inline tool and cannot be executed at resolution time.',
    };
  }
  const input = (args.item.edited_arguments ??
    proposed.arguments ??
    {}) as Record<string, unknown>;

  if (isNativeProposal(proposed.tool_id)) {
    return executeApprovedNativeAction({
      toolId: proposed.tool_id,
      item: args.item,
      projectInternalId: args.projectInternalId,
      input,
    });
  }

  log(
    'executeApprovedAction: id=%s toolId=%s action=%s',
    args.item.id,
    proposed.tool_id,
    proposed.action ?? '(none)'
  );

  const rawResult = await callTool({
    // The guardrail that filed this approval is what classified the call, and a
    // human then approved these arguments; re-classifying would re-decide what
    // the sign-off already settled.
    guardrails: 'already-adjudicated',
    // The agent's binding may name a tool another project shares with it.
    projectId: args.projectInternalId,
    reach: 'shares',
    id: proposed.tool_id,
    action: proposed.action,
    input,
    // The approved action runs as the chain's principal too, not just the
    // continuation that reports it — a proposed `soat` call is executed here,
    // and without the credential it reaches the loopback unauthenticated.
    authority: args.authority,
    toolContext: args.toolContext,
    attribution: { generationId: args.item.generation_id },
    signedOff: {
      frozenArguments: isPlainObject(proposed.arguments)
        ? proposed.arguments
        : {},
    },
    agentAuthority: await proposingAgentAuthority({
      item: args.item,
      projectInternalId: args.projectInternalId,
    }),
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
const reportsExpiryToAgent = async (args: {
  item: MappedApproval;
  projectInternalId: number;
}): Promise<boolean> => {
  if (!args.item.agent_id) return false;
  const agent = await agentReferences.find({
    id: args.item.agent_id,
    projectId: args.projectInternalId,
    reach: 'project',
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
  authority: WorkAuthority | null;
  toolContext?: Record<string, string>;
}): Promise<void> => {
  const { item } = args;
  if (!item.agent_id) return;

  const message = buildContinuationMessage({ item, decision: args.decision });

  if (item.session_id) {
    const agent = await agentReferences.find({
      id: item.agent_id,
      projectId: args.projectInternalId,
      reach: 'project',
    });
    if (!agent) return;
    log('fireContinuation: session id=%s session=%s', item.id, item.session_id);
    await sendSessionMessage({
      agentId: agent.id as number,
      sessionId: item.session_id,
      message,
      authority: args.authority,
      // No request drives a continuation: it runs under `authority`.
      authUser: undefined,
      toolContext: args.toolContext,
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
    // The chain's authority, which the continuation's generation stores, so a
    // further approval in the same chain runs under it in turn.
    authority: args.authority,
    toolContext: args.toolContext,
  });
};

/**
 * Runs the full tool-call continuation for a resolved `tool_call` item: execute
 * the approved action (populating the decision `result`), then fire the
 * continuation generation. Self-contained — it never rejects, so the resume
 * handler can fire it and forget it without an unhandled rejection.
 */
const runToolCallContinuation = async (args: {
  item: MappedApproval;
  decision: DecisionOutput;
  toolContext?: Record<string, string>;
}): Promise<void> => {
  const { item } = args;
  if (!item.project_id) return;

  try {
    // The item's own project; a row deleted mid-resume lands in the catch below.
    const project = await db.Project.findOne({
      where: { publicId: item.project_id },
      rejectOnEmpty: true,
    });
    const projectInternalId = project.id as number;

    const authority = await resolveContinuationAuthority({ item });

    let result: object | null = null;
    if (args.decision.decision === 'approved') {
      // A client tool cannot run server-side, so approval re-hands the call off
      // via a fresh linked generation and there is no server-side result or NL
      // continuation — the client resumes the loop itself.
      const reHandedOff = await emitClientToolReHandoff({
        item,
        projectInternalId,
        authority,
        toolContext: args.toolContext,
      });
      if (reHandedOff) return;

      result = await executeApprovedAction({
        item,
        projectInternalId,
        authority,
        toolContext: args.toolContext,
      }).catch((error: unknown) => {
        log('executeApprovedAction failed id=%s %o', item.id, error);
        return { error: errorMessage(error) };
      });
    }

    // An expiry means nobody was at the wheel, so by default there is nobody to
    // report to and nothing a turn would add: the `expired` row, the
    // `approvals.expired` event and the auto-filed exception are already the
    // whole record. Continuing instead compounds a runaway chain — under a
    // forcing `tool_choice` the reported-to turn can only propose more gated
    // calls, which expire, which continue again.
    if (
      args.decision.decision === 'expired' &&
      !(await reportsExpiryToAgent({ item, projectInternalId }))
    ) {
      log('runToolCallContinuation: expiry is terminal id=%s', item.id);
      await recordChainExpiry(item);
      return;
    }

    await fireContinuation({
      item,
      decision: { ...args.decision, result },
      projectInternalId,
      authority,
      toolContext: args.toolContext,
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
  toolContext,
}) => {
  if (item.origin !== 'tool_call') return;
  void runToolCallContinuation({ item, decision, toolContext });
};

registerApprovalResumeHandler(resumeToolCallApproval);
