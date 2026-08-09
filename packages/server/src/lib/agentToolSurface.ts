/**
 * The tool surface a generation runs with — resolved once, for both the fresh
 * turn and the resumed one.
 *
 * These were two functions, `resolveGenerationTools` (`agentGenerationContext`)
 * and `resolveRecoveryTools` (`agentGenerationRecovery`), running the same
 * six-step sequence down to a verbatim-copied comment. They had already
 * diverged: the recovery copy never built the knowledge-derived tools, so an
 * agent with a `knowledge_config.write_memory_id` kept `write_memory` when its
 * paused generation resumed from the in-memory map and silently lost it when
 * the same generation resumed from the DB after a restart. Resolving the
 * surface in one place is what makes that difference unrepresentable.
 */
import type { Tool } from 'ai';

import type { TypedAgent } from './agentGenerationTypes';
import { buildKnowledgeTools } from './agentKnowledge';
import {
  deriveLegacyToolFields,
  readAgentToolBindings,
} from './agentToolBindings';
import { buildResolverGuardrailContext } from './agentToolGuardrail';
import { resolveAgentTools } from './agentToolResolver';
import { narrowToActiveTools } from './agentToolSelection';

export const resolveAgentToolSurface = async (args: {
  agentId: string;
  generationId: string;
  projectIds?: number[];
  typedAgent: TypedAgent;
  authHeader?: string;
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
   * #851 — the typed argument, never the `tool_context` bag: guard decisions
   * and their audit records must attribute to a session id the server derived,
   * not one a caller typed.
   */
  sessionId?: string | null;
}): Promise<Record<string, Tool>> => {
  const projectId = args.typedAgent.project.id as number;

  // Canonical bindings (legacy rows normalize lazily); no branch on presence —
  // resolveAgentTools no-ops on empty input, so this covers "no tools at all".
  const legacyViews = deriveLegacyToolFields(
    readAgentToolBindings(args.typedAgent)
  );

  const resolvedTools = await resolveAgentTools({
    // `active_tool_ids` narrows the bound set before resolution — filtering ids
    // here rather than resolved tools afterwards avoids needing an id→name map
    // on this path. A resumed run is restricted exactly like the run it resumes.
    toolIds: narrowToActiveTools({
      toolIds: legacyViews.toolIds ?? [],
      activeToolIds: args.typedAgent.activeToolIds,
    }),
    tools: legacyViews.tools,
    projectId,
    projectIds: args.projectIds,
    boundaryPolicy: args.typedAgent.boundaryPolicy,
    authHeader: args.authHeader,
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
      authHeader: args.authHeader,
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
  });

  // Mutates `resolvedTools` in place, adding the tools derived from the agent's
  // `knowledge_config` (`write_memory`) on top of the bound ones.
  buildKnowledgeTools({
    agentId: args.agentId,
    projectIds: args.projectIds,
    typedAgent: args.typedAgent,
    resolvedTools,
  });

  return resolvedTools;
};
