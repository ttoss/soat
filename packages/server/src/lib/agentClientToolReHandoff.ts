import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { buildGenerationContext } from './agentGenerationContext';
import { savePendingGeneration } from './agentGenerationHelpers';
import type { MappedApproval } from './approvals';
import { resolveChainLineage } from './generationChain';
import { createGenerationRecord } from './generations';
import { readRunTokenPrincipal } from './orchestrationRunToken';
import { startedByPrincipalColumns } from './principals';

const log = createDebug('soat:approvals');

// The message the resumed agent sees once the client returns the approved call's
// result — enough context for it to finish the turn it proposed.
const buildReHandoffNote = (args: {
  toolName: string;
  approvalId: string;
}): string => {
  return [
    `Your proposed call to the client tool \`${args.toolName}\` was approved`,
    `(approval ${args.approvalId}).`,
    'It has been released to the client for execution; its result follows.',
  ].join(' ');
};

// One already-approved client call, released directly rather than re-gated. The
// tool-call id is deterministic so the assistant call and the submitted result
// stay paired.
const seedReHandoffPending = (args: {
  agentId: string;
  toolName: string;
  frozenArgs: Record<string, unknown>;
  ctx: Awaited<ReturnType<typeof buildGenerationContext>>;
  traceId: string;
  parentTraceId: string | null;
  rootTraceId: string | null;
}): void => {
  const toolCallId = `call_${args.ctx.generationId}`;
  savePendingGeneration({
    generationId: args.ctx.generationId,
    traceId: args.traceId,
    parentTraceId: args.parentTraceId,
    rootTraceId: args.rootTraceId,
    pendingToolCalls: [
      { toolCallId, toolName: args.toolName, input: args.frozenArgs },
    ],
    allMessages: args.ctx.allMessages,
    result: {
      steps: [],
      response: {
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolCallId,
                toolName: args.toolName,
                input: args.frozenArgs,
              },
            ],
          },
        ],
      },
    },
    model: args.ctx.model,
    typedAgent: args.ctx.typedAgent,
    agentId: args.agentId,
    resolvedTools: args.ctx.resolvedTools,
    toolContext: args.ctx.toolContext ?? null,
    remainingDepth: null,
  });
};

/**
 * Class-C (and escalated class-B) client-tool approvals cannot be executed
 * server-side on approval the way a persisted server tool is — a client tool
 * only runs on the caller. So instead of `callTool`, approving one **re-hands
 * the frozen (or edited) call off to the client**: a fresh generation, linked to
 * the original via `initiator_generation_id`, is created already suspended at
 * `requires_action` with exactly the approved call pending. The client executes
 * it and submits outputs to the new generation id, resuming the loop normally.
 *
 * Returns `true` when it handled a client tool (the caller must then skip the
 * server-side execution path); `false` for a non-client or inline tool, so the
 * caller falls back to the normal `callTool` continuation.
 */
export const emitClientToolReHandoff = async (args: {
  item: MappedApproval;
  projectInternalId: number;
  // The re-handoff generation resolves its tool surface here and is resumed
  // later by the client, so it needs the same identity as the other two
  // continuation branches — and records the same principal, so a further
  // approval re-mints from its own row.
  authHeader?: string;
}): Promise<boolean> => {
  const proposed = args.item.proposed_action;
  const agentId = args.item.agent_id;
  // Inline-tool proposals carry no persisted id to re-resolve the tool surface.
  if (!proposed?.tool_id || !agentId) return false;

  const tool = await db.Tool.findOne({ where: { publicId: proposed.tool_id } });
  if (!tool || tool.type !== 'client') return false;

  const frozenArgs = (args.item.edited_arguments ??
    proposed.arguments ??
    {}) as Record<string, unknown>;

  log(
    'emitClientToolReHandoff: id=%s tool=%s agent=%s',
    args.item.id,
    tool.name,
    agentId
  );

  const note = buildReHandoffNote({
    toolName: tool.name,
    approvalId: args.item.id,
  });

  // Rebuild the agent's model + tool surface so the loop can continue once the
  // client returns the result. Session provenance rides along via toolContext.
  const ctx = await buildGenerationContext({
    agentId,
    projectIds: [args.projectInternalId],
    messages: [{ role: 'user', content: note }],
    authHeader: args.authHeader,
    toolContext: args.item.session_id
      ? { sessionId: args.item.session_id }
      : undefined,
  });

  const traceId = generatePublicId(PUBLIC_ID_PREFIXES.trace);
  // The re-handoff is a continuation like any other, so it joins the chain it
  // came from rather than starting a new root. It is not refused when that
  // chain is over budget: a human approved this specific call, which is the
  // one thing the runaway the budget exists for never had.
  const lineage = await resolveChainLineage({
    initiatorGenerationId: args.item.generation_id,
  });
  // Deliberately uncaught: swallowing here would seed a pending generation with
  // no DB row. A genuine failure belongs in `runToolCallContinuation`'s catch.
  await createGenerationRecord({
    publicId: ctx.generationId,
    projectId: args.projectInternalId,
    agentId,
    traceId,
    ...lineage,
    initiatorGenerationId: args.item.generation_id ?? null,
    ...startedByPrincipalColumns(readRunTokenPrincipal(args.authHeader)),
    // Keeps the continuation's usage attributed to the same end user as the
    // turn that produced the approval; the actor is derived from the session.
    sessionId: args.item.session_id,
    inputMessages: ctx.inputMessages,
  });

  seedReHandoffPending({
    agentId,
    toolName: tool.name,
    frozenArgs,
    ctx,
    traceId,
    ...lineage,
  });

  return true;
};
