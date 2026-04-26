import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import type { LanguageModel, ModelMessage, Tool } from 'ai';
import { stepCountIs, streamText } from 'ai';

import { traces } from './agentTraces';
import { emitEvent } from './eventBus';

// ── Types ─────────────────────────────────────────────────────────────────

export type PendingGeneration = {
  agentId: string;
  projectId: number;
  traceId: string;
  generationId: string;
  pendingToolCalls: Array<{
    toolCallId: string;
    toolName: string;
    args: unknown;
  }>;
  messages: Array<unknown>;
  resolvedModel: LanguageModel;
  agentConfig: {
    instructions: string | null;
    maxSteps: number;
    toolChoice: unknown;
    stopConditions: unknown;
    activeToolIds: string[] | null;
    stepRules: unknown;
    temperature: number | null;
  };
  resolvedTools: Record<string, Tool>;
  toolContext?: Record<string, string>;
};

export type GenerationResult = {
  id: string;
  traceId: string;
  status: 'completed' | 'requires_action';
  output?: {
    model: string;
    content: string;
    finishReason: string;
  };
  requiredAction?: {
    type: 'submit_tool_outputs';
    toolCalls: Array<{
      id: string;
      toolName: string;
      args: unknown;
    }>;
  };
};

export type TypedAgent = {
  instructions: string | null;
  model: string | null;
  toolIds: unknown;
  maxSteps: unknown;
  toolChoice: unknown;
  stopConditions: unknown;
  activeToolIds: unknown;
  stepRules: unknown;
  boundaryPolicy: unknown;
  temperature: unknown;
  project: { id: unknown; publicId: string };
  aiProvider: { publicId: string };
};

// ── In-Memory Store ───────────────────────────────────────────────────────

export const pendingGenerations = new Map<string, PendingGeneration>();

// ── Helpers ───────────────────────────────────────────────────────────────

export const buildDepthGuardResult = (args: {
  traceId: string;
  projectId: number;
  agentId: string;
}): GenerationResult => {
  traces.set(args.traceId, {
    id: args.traceId,
    projectId: args.projectId,
    agentId: args.agentId,
    status: 'completed',
    createdAt: new Date(),
    steps: [{ type: 'depth_guard', message: 'Maximum call depth reached' }],
  });
  return {
    id: generatePublicId(PUBLIC_ID_PREFIXES.generation),
    traceId: args.traceId,
    status: 'completed',
    output: {
      model: '',
      content: 'Maximum call depth reached',
      finishReason: 'stop',
    },
  };
};

export const buildAllMessages = (
  instructions: string | null,
  messages: Array<{ role: string; content: string }>
): Array<{ role: string; content: string }> => {
  if (!instructions) return messages;
  return [{ role: 'system', content: instructions }, ...messages];
};

export const runStreamGeneration = (args: {
  model: LanguageModel;
  allMessages: Array<{ role: string; content: string }>;
  resolvedTools: Record<string, Tool>;
  typedAgent: TypedAgent;
  traceId: string;
  agentId: string;
}): ReadableStream => {
  const result = streamText({
    model: args.model,
    messages: args.allMessages as ModelMessage[],
    tools:
      Object.keys(args.resolvedTools).length > 0
        ? args.resolvedTools
        : undefined,
    toolChoice:
      (args.typedAgent.toolChoice as
        | 'auto'
        | 'required'
        | { type: 'tool'; toolName: string }
        | undefined) ?? undefined,
    stopWhen: stepCountIs((args.typedAgent.maxSteps as number) ?? 20),
    temperature: (args.typedAgent.temperature as number) ?? undefined,
  });
  traces.set(args.traceId, {
    id: args.traceId,
    projectId: args.typedAgent.project.id as number,
    agentId: args.agentId,
    status: 'completed',
    createdAt: new Date(),
    steps: [],
  });
  return result.textStream as unknown as ReadableStream;
};

export const findPendingClientTools = (
  steps: Array<{
    toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }>;
  }>,
  resolvedTools: Record<string, Tool>
): Array<{ toolCallId: string; toolName: string; input: unknown }> => {
  return steps
    .flatMap((step) => {
      return step.toolCalls ?? [];
    })
    .filter((tc) => {
      const resolvedTool = resolvedTools[tc.toolName];
      return resolvedTool && !('execute' in resolvedTool);
    });
};

export const savePendingGeneration = (args: {
  generationId: string;
  traceId: string;
  pendingToolCalls: Array<{
    toolCallId: string;
    toolName: string;
    input: unknown;
  }>;
  allMessages: Array<{ role: string; content: string }>;
  result: { steps: unknown[]; response: { messages: unknown[] } };
  model: LanguageModel;
  typedAgent: TypedAgent;
  agentId: string;
  resolvedTools: Record<string, Tool>;
}): GenerationResult => {
  traces.set(args.traceId, {
    id: args.traceId,
    projectId: args.typedAgent.project.id as number,
    agentId: args.agentId,
    status: 'requires_action',
    createdAt: new Date(),
    steps: args.result.steps as unknown[],
  });

  pendingGenerations.set(args.generationId, {
    agentId: args.agentId,
    projectId: args.typedAgent.project.id as number,
    traceId: args.traceId,
    generationId: args.generationId,
    pendingToolCalls: args.pendingToolCalls.map((tc) => {
      return {
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.input,
      };
    }),
    messages: [...args.allMessages, ...args.result.response.messages],
    resolvedModel: args.model,
    agentConfig: {
      instructions: args.typedAgent.instructions,
      maxSteps: (args.typedAgent.maxSteps as number) ?? 20,
      toolChoice: args.typedAgent.toolChoice,
      stopConditions: args.typedAgent.stopConditions,
      activeToolIds: args.typedAgent.activeToolIds as string[] | null,
      stepRules: args.typedAgent.stepRules,
      temperature: args.typedAgent.temperature as number | null,
    },
    resolvedTools: args.resolvedTools,
  });

  const requiresActionResult: GenerationResult = {
    id: args.generationId,
    traceId: args.traceId,
    status: 'requires_action',
    requiredAction: {
      type: 'submit_tool_outputs',
      toolCalls: args.pendingToolCalls.map((tc) => {
        return {
          id: tc.toolCallId,
          toolName: tc.toolName,
          args: tc.input,
        };
      }),
    },
  };

  emitEvent({
    type: 'agents.generation.requires_action',
    projectId: args.typedAgent.project.id as number,
    projectPublicId: args.typedAgent.project.publicId,
    resourceType: 'generation',
    resourceId: args.generationId,
    data: requiresActionResult as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return requiresActionResult;
};

export const buildCompletedGenerationResult = (args: {
  generationId: string;
  traceId: string;
  result: {
    steps: unknown[];
    response?: { modelId?: string };
    text: string;
    finishReason: string;
  };
  typedAgent: TypedAgent;
  agentId: string;
}): GenerationResult => {
  traces.set(args.traceId, {
    id: args.traceId,
    projectId: args.typedAgent.project.id as number,
    agentId: args.agentId,
    status: 'completed',
    createdAt: new Date(),
    steps: args.result.steps as unknown[],
  });

  const completedResult: GenerationResult = {
    id: args.generationId,
    traceId: args.traceId,
    status: 'completed',
    output: {
      model: args.result.response?.modelId ?? args.typedAgent.model ?? '',
      content: args.result.text,
      finishReason: args.result.finishReason,
    },
  };

  emitEvent({
    type: 'agents.generation.completed',
    projectId: args.typedAgent.project.id as number,
    projectPublicId: args.typedAgent.project.publicId,
    resourceType: 'generation',
    resourceId: args.generationId,
    data: completedResult as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return completedResult;
};
