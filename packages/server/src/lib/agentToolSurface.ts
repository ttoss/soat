/**
 * The tool surface a generation runs with — resolved once, for both the fresh
 * turn and the resumed one, so a resumed generation is offered exactly the
 * tools (knowledge-derived ones included) its fresh turn was.
 */
import type { Tool } from 'ai';

import type { AgentAuthority } from './agentAuthority';
import { ownerProjectId, type TypedAgent } from './agentGenerationTypes';
import { buildKnowledgeBindings } from './agentKnowledge';
import { readAgentToolBindings, splitToolBindings } from './agentToolBindings';
import { buildResolverGuardrailContext } from './agentToolGuardrail';
import { gateAndMergeBindings } from './agentToolNames';
import { resolveAgentToolBindings } from './agentToolResolver';
import { narrowToActiveTools } from './agentToolSelection';
import { collectUnavailableTools } from './agentToolUnavailable';
import type { GenerationProvenance } from './generationProvenance';
import { markedToolResult } from './toolCallOutcome';
import { toolErrorAnswer } from './toolErrorRelay';
import { withReadableFileOutputs } from './toolResultFiles';
import { turnAuthority } from './turnAuthority';
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
 * Settles with `run`, or rejects with the signal's reason once it aborts, so a
 * tool that ignores the signal still stops holding the turn.
 */
const untilAborted = <T>(args: {
  run: () => PromiseLike<T> | T;
  signal: AbortSignal | undefined;
}): Promise<T> => {
  const { signal } = args;
  if (!signal) return Promise.resolve(args.run());
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve()
      .then(args.run)
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener('abort', onAbort);
      });
  });
};

/**
 * Every tool runs under the segment's abort signal. An error this API relays
 * or decides (`toolErrorAnswer`) reaches the model as the body REST answers,
 * with its `code` and `meta`, not the AI SDK's error string.
 */
const relayErrorsAsResults = (args: {
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
              return await untilAborted({
                run: () => {
                  return execute(...executeArgs);
                },
                signal: executeArgs[1]?.abortSignal,
              });
            } catch (error) {
              const answer = toolErrorAnswer(error);
              if (!answer) throw error;
              return markedToolResult(answer);
            }
          },
        },
      ];
    })
  );
};

/** The merged bindings, each call's file output read under the turn's authority. */
const servedTools = (args: {
  merge: Parameters<typeof gateAndMergeBindings>[0];
  turnProjectId: number;
  generationId: string;
  authority: WorkAuthority | null;
}): Record<string, Tool> => {
  return relayErrorsAsResults({
    tools: withReadableFileOutputs({
      tools: gateAndMergeBindings(args.merge),
      turnProjectId: args.turnProjectId,
      generationId: args.generationId,
      authority: args.authority,
    }),
  });
};

export const resolveAgentToolSurface = async (args: {
  agentId: string;
  generationId: string;
  projectIds?: number[];
  typedAgent: TypedAgent;
  /**
   * The agent's `policy_ids` resolved for this turn (`resolveAgentAuthority`).
   * Required, so no path offers tools uncapped by omission.
   */
  agentAuthority: AgentAuthority;
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
  /** The turn's tally, which its tools count their results into. */
  provenance: GenerationProvenance;
}): Promise<ResolvedToolSurface> => {
  // Bindings resolve in the agent's own project; the turn's calls are gated,
  // metered and recorded in the project it runs in.
  const projectId = args.typedAgent.project.id as number;
  const ownerId = ownerProjectId(args.typedAgent);
  const unavailable = collectUnavailableTools();

  // No branch on presence — resolveAgentToolBindings no-ops on empty input, so
  // this covers "no tools at all".
  const bound = splitToolBindings(readAgentToolBindings(args.typedAgent));

  // Guardrails are the single tool-call gating mechanism: every binding below,
  // bound or knowledge-derived, passes this one context's gate at the merge.
  const guardrail = await buildResolverGuardrailContext({
    agentId: args.agentId,
    generationId: args.generationId,
    projectId,
    projectPublicId: args.typedAgent.project.publicId,
    projectGuardrailIds: args.typedAgent.project.guardrailIds,
    agentGuardrailIds: args.typedAgent.guardrailIds,
    sessionId: args.sessionId ?? null,
    authority: args.authority,
    guardrailContext: args.guardrailContext,
    provenance: args.provenance,
  });

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
    agentAuthority: args.agentAuthority,
    authority: args.authority,
    toolContext: args.toolContext,
    traceId: args.traceId,
    parentTraceId: args.parentTraceId,
    rootTraceId: args.rootTraceId,
    remainingDepth: args.remainingDepth,
    guardrail,
    // Credits a successful call to this agent and generation on the activity
    // feed; a resumed generation's calls record under the same identity.
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
          ...args,
          projectId,
          actorId: args.toolContext?.actor_id,
          baseGuardrails: guardrail.baseGuardrails,
        })
      : [];

  return {
    tools: servedTools({
      merge: { bindings: [...bindings, ...knowledgeBindings], guardrail },
      turnProjectId: projectId,
      generationId: args.generationId,
      authority: turnAuthority(args),
    }),
    unavailableToolNames: unavailable.names,
  };
};
