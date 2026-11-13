/**
 * The tool surface a generation runs with — resolved once, for both the fresh
 * turn and the resumed one, so a resumed generation is offered exactly the
 * tools (knowledge-derived ones included) its fresh turn was.
 */
import type { Tool } from 'ai';

import type { AgentBoundary } from './agentBoundary';
import { ownerProjectId, type TypedAgent } from './agentGenerationTypes';
import { buildKnowledgeBindings } from './agentKnowledge';
import { readAgentToolBindings, splitToolBindings } from './agentToolBindings';
import { buildResolverGuardrailContext } from './agentToolGuardrail';
import { mergeBindingTools } from './agentToolNames';
import { resolveAgentToolBindings } from './agentToolResolver';
import { narrowToActiveTools } from './agentToolSelection';
import { collectUnavailableTools } from './agentToolUnavailable';
import { denialToolResult, isAuthorizationDenial } from './authorizationDenial';
import type { WorkAuthority } from './workAuthority';

/**
 * The tools the turn runs with, and the bindings that contributed none — the
 * second half being what the turn's prompt needs so the model can say it could
 * not reach a tool rather than that it has none.
 */
export type ResolvedToolSurface = {
  tools: Record<string, Tool>;
  unavailableToolNames: string[];
};

/**
 * A denial thrown inside any tool reaches the model as the tool result a
 * refusal answers, with its `code` and `meta`, not the AI SDK's error string.
 */
const relayDenialsAsResults = (args: {
  tools: Record<string, Tool>;
}): Record<string, Tool> => {
  return Object.fromEntries(
    Object.entries(args.tools).map(([name, resolved]) => {
      const { execute } = resolved;
      if (!execute) return [name, resolved];
      return [
        name,
        {
          ...resolved,
          execute: async (...executeArgs: Parameters<typeof execute>) => {
            try {
              return await execute(...executeArgs);
            } catch (error) {
              if (isAuthorizationDenial(error)) return denialToolResult(error);
              throw error;
            }
          },
        },
      ];
    })
  );
};

export const resolveAgentToolSurface = async (args: {
  agentId: string;
  generationId: string;
  projectIds?: number[];
  typedAgent: TypedAgent;
  /**
   * The agent's `policy_ids` resolved for this turn (`resolveAgentBoundary`).
   * Required, so no path offers tools uncapped by omission.
   */
  boundary: AgentBoundary;
  authority: WorkAuthority | null;
  toolContext?: Record<string, string>;
  traceId?: string;
  parentTraceId?: string | null;
  rootTraceId?: string | null;
  remainingDepth?: number;
  /**
   * Caller-supplied `context.*` guard inputs. Absent on the resumed path: the
   * caller's `guardrail_context` is not persisted across the tool-outputs
   * round trip, so only project/agent/tool scope guardrails apply there and
   * caller `context.*` keys fail closed.
   */
  guardrailContext?: Record<string, unknown> | null;
  /**
   * The typed argument, never the `tool_context` bag: guard decisions and their
   * audit records must attribute to a session id the server derived, not one a
   * caller typed.
   */
  sessionId?: string | null;
}): Promise<ResolvedToolSurface> => {
  // Bindings resolve in the agent's own project; the turn's calls are gated,
  // metered and recorded in the project it runs in.
  const projectId = args.typedAgent.project.id as number;
  const ownerId = ownerProjectId(args.typedAgent);
  const unavailable = collectUnavailableTools();

  // No branch on presence — resolveAgentToolBindings no-ops on empty input, so
  // this covers "no tools at all".
  const bound = splitToolBindings(readAgentToolBindings(args.typedAgent));

  const bindings = await resolveAgentToolBindings({
    // `active_tool_ids` narrows the bound set before resolution — filtering ids
    // here rather than resolved tools afterwards avoids needing an id→name map
    // on this path. A resumed run is restricted exactly like the run it resumes.
    toolIds: narrowToActiveTools({
      toolIds: bound.toolIds,
      activeToolIds: args.typedAgent.activeToolIds,
    }),
    tools: bound.tools,
    projectId: ownerId,
    callerProjectId: projectId,
    projectPublicId: args.typedAgent.project.publicId,
    projectIds: args.projectIds,
    boundary: args.boundary,
    authority: args.authority,
    toolContext: args.toolContext,
    traceId: args.traceId,
    parentTraceId: args.parentTraceId,
    rootTraceId: args.rootTraceId,
    remainingDepth: args.remainingDepth,
    // Guardrails are the single tool-call gating mechanism.
    guardrail: await buildResolverGuardrailContext({
      agentId: args.agentId,
      generationId: args.generationId,
      projectId,
      projectPublicId: args.typedAgent.project.publicId,
      projectGuardrailIds: args.typedAgent.project.guardrailIds,
      agentGuardrailIds: args.typedAgent.guardrailIds,
      sessionId: args.sessionId ?? null,
      authority: args.authority,
      guardrailContext: args.guardrailContext,
    }),
    // Attributes a successful tool call to this agent/generation on the activity
    // feed (approvals PRD Phase 4). A resumed generation's tool calls are as
    // autonomous as a fresh one's, so they record under the same identity.
    activity: {
      projectId,
      agentId: args.agentId,
      generationId: args.generationId,
    },
    unavailable: unavailable.sink,
    attribution: { generationId: args.generationId, agentId: args.agentId },
  });

  // A shared agent's memory store is its owner's: the grantee's turn is never
  // written into it.
  const knowledgeBindings =
    ownerId === projectId
      ? buildKnowledgeBindings({
          agentId: args.agentId,
          generationId: args.generationId,
          projectId,
          typedAgent: args.typedAgent,
          boundaryPolicy: args.boundary.policy,
          actorId: args.toolContext?.actor_id,
        })
      : [];

  return {
    tools: relayDenialsAsResults({
      tools: mergeBindingTools({
        bindings: [...bindings, ...knowledgeBindings],
      }),
    }),
    unavailableToolNames: unavailable.names,
  };
};
