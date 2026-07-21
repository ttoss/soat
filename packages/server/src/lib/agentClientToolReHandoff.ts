import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import createDebug from 'debug';

import { db } from '../db';
import { buildGenerationContext } from './agentGenerationContext';
import { savePendingGeneration } from './agentGenerationHelpers';
import type { MappedApproval } from './approvals';
import { createGenerationRecord } from './generations';

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

// Seeds and stores the re-handoff generation: one already-approved client call,
// released directly (NOT re-gated), suspended at `requires_action`. A
// deterministic tool-call id keeps the assistant tool-call and the submitted
// tool-result paired.
const seedReHandoffPending = (args: {
  agentId: string;
  toolName: string;
  frozenArgs: Record<string, unknown>;
  ctx: Awaited<ReturnType<typeof buildGenerationContext>>;
  traceId: string;
}): void => {
  const toolCallId = `call_${args.ctx.generationId}`;
  savePendingGeneration({
    generationId: args.ctx.generationId,
    traceId: args.traceId,
    parentTraceId: null,
    rootTraceId: null,
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
}): Promise<boolean> => {
  const proposed = args.item.proposedAction;
  const agentId = args.item.agentId;
  // Inline-tool proposals carry no persisted id to re-resolve the tool surface.
  if (!proposed?.toolId || !agentId) return false;

  const tool = await db.Tool.findOne({ where: { publicId: proposed.toolId } });
  if (!tool || tool.type !== 'client') return false;

  const frozenArgs = (args.item.editedArguments ??
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
    toolContext: args.item.sessionId
      ? { sessionId: args.item.sessionId }
      : undefined,
  });

  const traceId = generatePublicId(PUBLIC_ID_PREFIXES.trace);
  // Not wrapped in `.catch`: the initiator, agent, and project all exist in the
  // real flow (this runs off an approval those rows produced). A genuine failure
  // propagates to runToolCallContinuation's catch, which is the right place to
  // fall back — swallowing here would seed a pending generation with no DB row.
  await createGenerationRecord({
    publicId: ctx.generationId,
    projectId: args.projectInternalId,
    agentId,
    traceId,
    initiatorGenerationId: args.item.generationId ?? null,
    startedByPrincipalType: null,
    startedByPrincipalId: null,
  });

  seedReHandoffPending({
    agentId,
    toolName: tool.name,
    frozenArgs,
    ctx,
    traceId,
  });

  return true;
};
