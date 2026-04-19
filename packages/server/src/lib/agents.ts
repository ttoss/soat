import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createOpenAI } from '@ai-sdk/openai';
import { createXai } from '@ai-sdk/xai';
import type { AiProviderSlug } from '@soat/postgresdb';
import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import type { JSONSchema7, LanguageModel, ModelMessage, Tool } from 'ai';
import { generateText, jsonSchema, stepCountIs, streamText, tool } from 'ai';
import { resolveAiProviderSecret } from 'src/lib/aiProviders';
import {
  evaluatePolicies,
  type PolicyDocument,
  validatePolicyDocument,
} from 'src/lib/iam';

import { db } from '../db';
import { allSoatTools } from './soat-tools';

// ── Mapped Types ─────────────────────────────────────────────────────────

export type MappedAgentTool = {
  id: string;
  projectId: string;
  type: string;
  name: string;
  description: string | null;
  parameters: object | null;
  execute: object | null;
  mcp: object | null;
  actions: string[] | null;
  createdAt: Date;
  updatedAt: Date;
};

export type MappedAgent = {
  id: string;
  projectId: string;
  aiProviderId: string;
  name: string | null;
  instructions: string | null;
  model: string | null;
  toolIds: string[] | null;
  maxSteps: number | null;
  toolChoice: object | null;
  stopConditions: object[] | null;
  activeToolIds: string[] | null;
  stepRules: object[] | null;
  boundaryPolicy: object | null;
  temperature: number | null;
  createdAt: Date;
  updatedAt: Date;
};

// ── Map Functions ────────────────────────────────────────────────────────

const getAgentToolIncludes = () => {
  return [{ model: db.Project, as: 'project' }];
};

const mapAgentTool = (
  tool: InstanceType<typeof db.AgentTool> & {
    project: InstanceType<typeof db.Project>;
  }
): MappedAgentTool => {
  return {
    id: tool.publicId,
    projectId: tool.project.publicId,
    type: tool.type,
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    execute: tool.execute,
    mcp: tool.mcp,
    actions: tool.actions,
    createdAt: tool.createdAt,
    updatedAt: tool.updatedAt,
  };
};

const getAgentIncludes = () => {
  return [
    { model: db.Project, as: 'project' },
    { model: db.AiProvider, as: 'aiProvider' },
  ];
};

const mapAgent = (
  agent: InstanceType<typeof db.Agent> & {
    project: InstanceType<typeof db.Project>;
    aiProvider: InstanceType<typeof db.AiProvider>;
  }
): MappedAgent => {
  return {
    id: agent.publicId,
    projectId: agent.project.publicId,
    aiProviderId: agent.aiProvider.publicId,
    name: agent.name,
    instructions: agent.instructions,
    model: agent.model,
    toolIds: agent.toolIds,
    maxSteps: agent.maxSteps,
    toolChoice: agent.toolChoice,
    stopConditions: agent.stopConditions,
    activeToolIds: agent.activeToolIds,
    stepRules: agent.stepRules,
    boundaryPolicy: agent.boundaryPolicy,
    temperature: agent.temperature,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
};

// ── Agent Tool CRUD ──────────────────────────────────────────────────────

export const createAgentTool = async (args: {
  projectId: number;
  type?: string;
  name: string;
  description?: string;
  parameters?: object;
  execute?: object;
  mcp?: object;
  actions?: string[];
}): Promise<MappedAgentTool> => {
  const agentTool = await db.AgentTool.create({
    projectId: args.projectId,
    type: args.type ?? 'http',
    name: args.name,
    description: args.description ?? null,
    parameters: args.parameters ?? null,
    execute: args.execute ?? null,
    mcp: args.mcp ?? null,
    actions: args.actions ?? null,
  });

  const created = await db.AgentTool.findOne({
    where: { id: (agentTool as unknown as { id: number }).id },
    include: getAgentToolIncludes(),
  });

  return mapAgentTool(created as unknown as Parameters<typeof mapAgentTool>[0]);
};

export const listAgentTools = async (args: {
  projectIds?: number[];
}): Promise<MappedAgentTool[]> => {
  const where: Record<string, unknown> = {};
  if (args.projectIds !== undefined) {
    where.projectId = args.projectIds;
  }

  const tools = await db.AgentTool.findAll({
    where,
    include: getAgentToolIncludes(),
    order: [['createdAt', 'DESC']],
  });

  return tools.map((t) => {
    return mapAgentTool(t as unknown as Parameters<typeof mapAgentTool>[0]);
  });
};

export const getAgentTool = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<MappedAgentTool | 'not_found'> => {
  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds !== undefined) {
    where.projectId = args.projectIds;
  }

  const agentTool = await db.AgentTool.findOne({
    where,
    include: getAgentToolIncludes(),
  });

  if (!agentTool) {
    return 'not_found';
  }

  return mapAgentTool(
    agentTool as unknown as Parameters<typeof mapAgentTool>[0]
  );
};

export const updateAgentTool = async (args: {
  projectIds?: number[];
  id: string;
  type?: string;
  name?: string;
  description?: string | null;
  parameters?: object | null;
  execute?: object | null;
  mcp?: object | null;
  actions?: string[] | null;
}): Promise<MappedAgentTool | 'not_found'> => {
  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds !== undefined) {
    where.projectId = args.projectIds;
  }

  const agentTool = await db.AgentTool.findOne({
    where,
  });

  if (!agentTool) {
    return 'not_found';
  }

  const updates: Record<string, unknown> = {};
  if (args.type !== undefined) updates.type = args.type;
  if (args.name !== undefined) updates.name = args.name;
  if (args.description !== undefined) updates.description = args.description;
  if (args.parameters !== undefined) updates.parameters = args.parameters;
  if (args.execute !== undefined) updates.execute = args.execute;
  if (args.mcp !== undefined) updates.mcp = args.mcp;
  if (args.actions !== undefined) updates.actions = args.actions;

  await agentTool.update(updates);

  const updated = await db.AgentTool.findOne({
    where: { id: (agentTool as unknown as { id: number }).id },
    include: getAgentToolIncludes(),
  });

  return mapAgentTool(updated as unknown as Parameters<typeof mapAgentTool>[0]);
};

export const deleteAgentTool = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<'ok' | 'not_found'> => {
  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds !== undefined) {
    where.projectId = args.projectIds;
  }

  const agentTool = await db.AgentTool.findOne({
    where,
  });

  if (!agentTool) {
    return 'not_found';
  }

  await agentTool.destroy();
  return 'ok';
};

// ── Agent CRUD ───────────────────────────────────────────────────────────

export const createAgent = async (args: {
  projectId: number;
  aiProviderId: string;
  name?: string;
  instructions?: string;
  model?: string;
  toolIds?: string[];
  maxSteps?: number;
  toolChoice?: object;
  stopConditions?: object[];
  activeToolIds?: string[];
  stepRules?: object[];
  boundaryPolicy?: object;
  temperature?: number;
}): Promise<MappedAgent | 'ai_provider_not_found'> => {
  const aiProvider = await db.AiProvider.findOne({
    where: { publicId: args.aiProviderId },
  });

  if (!aiProvider) {
    return 'ai_provider_not_found';
  }

  const agent = await db.Agent.create({
    projectId: args.projectId,
    aiProviderId: (aiProvider as unknown as { id: number }).id,
    name: args.name ?? null,
    instructions: args.instructions ?? null,
    model: args.model ?? null,
    toolIds: args.toolIds ?? null,
    maxSteps: args.maxSteps ?? 20,
    toolChoice: args.toolChoice ?? null,
    stopConditions: args.stopConditions ?? null,
    activeToolIds: args.activeToolIds ?? null,
    stepRules: args.stepRules ?? null,
    boundaryPolicy: args.boundaryPolicy ?? null,
    temperature: args.temperature ?? null,
  });

  const created = await db.Agent.findOne({
    where: { id: (agent as unknown as { id: number }).id },
    include: getAgentIncludes(),
  });

  return mapAgent(created as unknown as Parameters<typeof mapAgent>[0]);
};

export const listAgents = async (args: {
  projectIds?: number[];
}): Promise<MappedAgent[]> => {
  const where: Record<string, unknown> = {};
  if (args.projectIds !== undefined) {
    where.projectId = args.projectIds;
  }

  const agents = await db.Agent.findAll({
    where,
    include: getAgentIncludes(),
    order: [['createdAt', 'DESC']],
  });

  return agents.map((a) => {
    return mapAgent(a as unknown as Parameters<typeof mapAgent>[0]);
  });
};

export const getAgent = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<MappedAgent | 'not_found'> => {
  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds !== undefined) {
    where.projectId = args.projectIds;
  }

  const agent = await db.Agent.findOne({
    where,
    include: getAgentIncludes(),
  });

  if (!agent) {
    return 'not_found';
  }

  return mapAgent(agent as unknown as Parameters<typeof mapAgent>[0]);
};

export const updateAgent = async (args: {
  projectIds?: number[];
  id: string;
  aiProviderId?: string;
  name?: string | null;
  instructions?: string | null;
  model?: string | null;
  toolIds?: string[] | null;
  maxSteps?: number | null;
  toolChoice?: object | null;
  stopConditions?: object[] | null;
  activeToolIds?: string[] | null;
  stepRules?: object[] | null;
  boundaryPolicy?: object | null;
  temperature?: number | null;
}): Promise<MappedAgent | 'not_found' | 'ai_provider_not_found'> => {
  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds !== undefined) {
    where.projectId = args.projectIds;
  }

  const agent = await db.Agent.findOne({
    where,
  });

  if (!agent) {
    return 'not_found';
  }

  const updates: Record<string, unknown> = {};

  if (args.aiProviderId !== undefined) {
    const aiProvider = await db.AiProvider.findOne({
      where: { publicId: args.aiProviderId },
    });
    if (!aiProvider) {
      return 'ai_provider_not_found';
    }
    updates.aiProviderId = (aiProvider as unknown as { id: number }).id;
  }

  if (args.name !== undefined) updates.name = args.name;
  if (args.instructions !== undefined) updates.instructions = args.instructions;
  if (args.model !== undefined) updates.model = args.model;
  if (args.toolIds !== undefined) updates.toolIds = args.toolIds;
  if (args.maxSteps !== undefined) updates.maxSteps = args.maxSteps;
  if (args.toolChoice !== undefined) updates.toolChoice = args.toolChoice;
  if (args.stopConditions !== undefined)
    updates.stopConditions = args.stopConditions;
  if (args.activeToolIds !== undefined)
    updates.activeToolIds = args.activeToolIds;
  if (args.stepRules !== undefined) updates.stepRules = args.stepRules;
  if (args.boundaryPolicy !== undefined)
    updates.boundaryPolicy = args.boundaryPolicy;
  if (args.temperature !== undefined) updates.temperature = args.temperature;

  await agent.update(updates);

  const updated = await db.Agent.findOne({
    where: { id: (agent as unknown as { id: number }).id },
    include: getAgentIncludes(),
  });

  return mapAgent(updated as unknown as Parameters<typeof mapAgent>[0]);
};

export const deleteAgent = async (args: {
  projectIds?: number[];
  id: string;
}): Promise<'ok' | 'not_found'> => {
  const where: Record<string, unknown> = { publicId: args.id };
  if (args.projectIds !== undefined) {
    where.projectId = args.projectIds;
  }

  const agent = await db.Agent.findOne({
    where,
  });

  if (!agent) {
    return 'not_found';
  }

  // Null out agentId on any actors linked to this agent before destroying.
  await db.Actor.update(
    { agentId: null },
    { where: { agentId: agent.id as number } }
  );

  await agent.destroy();
  return 'ok';
};

// ── AI Model Resolution (reused from chats) ─────────────────────────────

const buildModel = (args: {
  provider: AiProviderSlug;
  secretValue: string | null;
  model: string;
  baseUrl?: string;
  config?: Record<string, unknown>;
}): LanguageModel => {
  const { provider, secretValue, model, baseUrl, config } = args;
  const apiKey = secretValue ?? '';

  switch (provider) {
    case 'openai':
      return createOpenAI({ apiKey, baseURL: baseUrl })(model);
    case 'anthropic':
      return createAnthropic({ apiKey, baseURL: baseUrl })(model);
    case 'google':
      return createGoogleGenerativeAI({ apiKey })(model);
    case 'xai':
      return createXai({ apiKey })(model);
    case 'groq':
      return createGroq({ apiKey })(model);
    case 'azure': {
      const resourceName = (config?.resourceName as string | undefined) ?? '';
      return createAzure({ apiKey, resourceName })(model);
    }
    case 'bedrock': {
      let parsedCredentials:
        | {
            accessKeyId?: string;
            secretAccessKey?: string;
            sessionToken?: string;
          }
        | undefined;
      if (apiKey) {
        try {
          parsedCredentials = JSON.parse(apiKey);
        } catch {
          // fall back to default AWS credential chain
        }
      }
      const region = (config?.region as string | undefined) ?? 'us-east-1';
      return createAmazonBedrock({
        region,
        accessKeyId: parsedCredentials?.accessKeyId,
        secretAccessKey: parsedCredentials?.secretAccessKey,
        sessionToken: parsedCredentials?.sessionToken,
      })(model);
    }
    case 'ollama': {
      const ollamaBaseUrl =
        baseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
      return createOpenAI({
        apiKey: 'ollama',
        baseURL: `${ollamaBaseUrl}/v1`,
      }).chat(model);
    }
    case 'gateway':
    case 'custom':
      return createOpenAI({ apiKey, baseURL: baseUrl }).chat(model);
  }
};

// ── Generation In-Memory Store ───────────────────────────────────────────

type PendingGeneration = {
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
};

const pendingGenerations = new Map<string, PendingGeneration>();

const isSoatActionAllowedByBoundary = (args: {
  boundaryPolicy: unknown;
  iamAction: string;
}): boolean => {
  if (!args.boundaryPolicy) {
    return true;
  }

  const validation = validatePolicyDocument(args.boundaryPolicy);
  if (!validation.valid) {
    return false;
  }

  return evaluatePolicies({
    policies: [args.boundaryPolicy as PolicyDocument],
    action: args.iamAction,
    resource: '*',
  });
};

// ── Tool Resolution ──────────────────────────────────────────────────────

const resolveAgentTools = async (args: {
  toolIds: string[];
  projectIds?: number[];
  boundaryPolicy?: unknown;
  authHeader?: string;
}): Promise<Record<string, Tool>> => {
  const resolvedTools: Record<string, Tool> = {};

  for (const toolPublicId of args.toolIds) {
    const toolWhere: Record<string, unknown> = { publicId: toolPublicId };
    if (args.projectIds !== undefined) {
      toolWhere.projectId = args.projectIds;
    }

    const agentTool = await db.AgentTool.findOne({
      where: toolWhere,
    });

    if (!agentTool) {
      continue;
    }

    const typedTool = agentTool as unknown as {
      type: string;
      name: string;
      description: string | null;
      parameters: Record<string, unknown> | null;
      execute: { url: string; headers?: Record<string, string> } | null;
      mcp: { url: string; headers?: Record<string, string> } | null;
      actions: string[] | null;
    };

    switch (typedTool.type) {
      case 'http': {
        resolvedTools[typedTool.name] = tool({
          description: typedTool.description ?? undefined,
          inputSchema: jsonSchema(
            typedTool.parameters ?? { type: 'object', properties: {} }
          ),
          execute: async (toolArgs: unknown) => {
            const response = await fetch(typedTool.execute!.url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...typedTool.execute?.headers,
              },
              body: JSON.stringify(toolArgs),
            });
            return response.json();
          },
        });
        break;
      }

      case 'client': {
        // Client tools have no execute — they pause the generation
        resolvedTools[typedTool.name] = tool({
          description: typedTool.description ?? undefined,
          inputSchema: jsonSchema(
            typedTool.parameters ?? { type: 'object', properties: {} }
          ),
        });
        break;
      }

      case 'mcp': {
        // Discover tools from the MCP server, then register each as an AI SDK tool
        if (!typedTool.mcp?.url) break;

        const mcpUrl = typedTool.mcp.url;
        const mcpHeaders: Record<string, string> = {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...typedTool.mcp.headers,
        };

        const listResponse = await fetch(mcpUrl, {
          method: 'POST',
          headers: mcpHeaders,
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        });

        if (!listResponse.ok) break;

        const listBody = (await listResponse.json()) as {
          result?: {
            tools?: Array<{
              name: string;
              description?: string;
              inputSchema?: Record<string, unknown>;
            }>;
          };
        };

        const mcpTools = listBody.result?.tools ?? [];

        for (const mcpTool of mcpTools) {
          const mcpToolName = mcpTool.name;
          resolvedTools[mcpToolName] = tool({
            description: mcpTool.description ?? undefined,
            inputSchema: jsonSchema(
              mcpTool.inputSchema ?? { type: 'object', properties: {} }
            ),
            execute: async (toolArgs: unknown) => {
              const callResponse = await fetch(mcpUrl, {
                method: 'POST',
                headers: mcpHeaders,
                body: JSON.stringify({
                  jsonrpc: '2.0',
                  id: 2,
                  method: 'tools/call',
                  params: { name: mcpToolName, arguments: toolArgs },
                }),
              });
              const callBody = (await callResponse.json()) as {
                result?: { content?: Array<{ text?: string }> };
              };
              const text = callBody.result?.content?.[0]?.text;
              if (!text) return callBody;
              try {
                return JSON.parse(text);
              } catch {
                return text;
              }
            },
          });
        }
        break;
      }

      case 'soat': {
        const actions = typedTool.actions ?? [];
        const base = `http://localhost:${process.env.PORT || 5047}/api/v1`;

        for (const action of actions) {
          const def = allSoatTools.find((t) => {
            return t.name === action;
          });
          if (!def) continue;

          const resolvedToolName = `${typedTool.name}_${action}`;

          resolvedTools[resolvedToolName] = tool({
            description: typedTool.description ?? def.description,
            inputSchema: jsonSchema(def.inputSchema as JSONSchema7),
            execute: async (toolArgs: unknown) => {
              const iamAction = def.iamAction ?? def.name;
              if (
                !isSoatActionAllowedByBoundary({
                  boundaryPolicy: args.boundaryPolicy,
                  iamAction,
                })
              ) {
                return {
                  error: `Forbidden: boundary policy denies ${iamAction}`,
                };
              }

              const rawArgs = toolArgs as Record<string, unknown>;
              const path = def.path(rawArgs);
              const response = await fetch(`${base}${path}`, {
                method: def.method,
                headers: {
                  'Content-Type': 'application/json',
                  ...(args.authHeader
                    ? { Authorization: args.authHeader }
                    : {}),
                },
                body: def.body ? JSON.stringify(def.body(rawArgs)) : undefined,
              });
              return response.json();
            },
          });
        }
        break;
      }

      default:
        break;
    }
  }

  return resolvedTools;
};

// ── Traces (in-memory for now) ───────────────────────────────────────────

type Trace = {
  id: string;
  projectId: number;
  agentId: string;
  status: string;
  createdAt: Date;
  steps: Array<unknown>;
};

const traces = new Map<string, Trace>();

// ── Generation ───────────────────────────────────────────────────────────

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

export const createGeneration = async (args: {
  projectIds?: number[];
  agentId: string;
  messages: Array<{ role: string; content: string }>;
  stream?: boolean;
  traceId?: string;
  remainingDepth?: number;
  authHeader?: string;
}): Promise<
  GenerationResult | 'not_found' | 'ai_provider_not_found' | ReadableStream
> => {
  const maxDepth = args.remainingDepth ?? 10;
  const traceId = args.traceId ?? generatePublicId(PUBLIC_ID_PREFIXES.trace);

  if (maxDepth <= 0) {
    traces.set(traceId, {
      id: traceId,
      projectId: args.projectIds?.[0] ?? 0,
      agentId: args.agentId,
      status: 'completed',
      createdAt: new Date(),
      steps: [{ type: 'depth_guard', message: 'Maximum call depth reached' }],
    });

    return {
      id: generatePublicId(PUBLIC_ID_PREFIXES.generation),
      traceId,
      status: 'completed',
      output: {
        model: '',
        content: 'Maximum call depth reached',
        finishReason: 'stop',
      },
    };
  }

  const agentWhere: Record<string, unknown> = { publicId: args.agentId };
  if (args.projectIds !== undefined) {
    agentWhere.projectId = args.projectIds;
  }

  const agent = await db.Agent.findOne({
    where: agentWhere,
    include: getAgentIncludes(),
  });

  if (!agent) {
    return 'not_found';
  }

  const typedAgent = agent as unknown as Parameters<typeof mapAgent>[0];

  const resolved = await resolveAiProviderSecret({
    aiProviderId: typedAgent.aiProvider.publicId,
  });

  if (!resolved) {
    return 'ai_provider_not_found';
  }

  const model = buildModel({
    provider: resolved.provider,
    secretValue: resolved.secretValue,
    model: typedAgent.model ?? resolved.defaultModel,
    baseUrl: resolved.baseUrl,
    config: resolved.config as Record<string, unknown> | undefined,
  });

  const generationId = generatePublicId(PUBLIC_ID_PREFIXES.generation);

  // Resolve tools
  const resolvedTools = typedAgent.toolIds
    ? await resolveAgentTools({
        toolIds: typedAgent.toolIds as string[],
        projectIds: args.projectIds,
        boundaryPolicy: typedAgent.boundaryPolicy,
        authHeader: args.authHeader,
      })
    : {};

  const systemMessages: Array<{ role: 'system'; content: string }> = [];
  if (typedAgent.instructions) {
    systemMessages.push({ role: 'system', content: typedAgent.instructions });
  }

  const allMessages = [...systemMessages, ...args.messages];

  if (args.stream) {
    const result = streamText({
      model,
      messages: allMessages as ModelMessage[],
      tools: Object.keys(resolvedTools).length > 0 ? resolvedTools : undefined,
      toolChoice:
        (typedAgent.toolChoice as
          | 'auto'
          | 'required'
          | { type: 'tool'; toolName: string }
          | undefined) ?? undefined,
      stopWhen: stepCountIs((typedAgent.maxSteps as number) ?? 20),
      temperature: (typedAgent.temperature as number) ?? undefined,
    });

    traces.set(traceId, {
      id: traceId,
      projectId: typedAgent.project.id as number,
      agentId: args.agentId,
      status: 'completed',
      createdAt: new Date(),
      steps: [],
    });

    return result.textStream as unknown as ReadableStream;
  }

  const result = await generateText({
    model,
    messages: allMessages as ModelMessage[],
    tools: Object.keys(resolvedTools).length > 0 ? resolvedTools : undefined,
    toolChoice:
      (typedAgent.toolChoice as
        | 'auto'
        | 'required'
        | { type: 'tool'; toolName: string }
        | undefined) ?? undefined,
    stopWhen: stepCountIs((typedAgent.maxSteps as number) ?? 20),
    temperature: (typedAgent.temperature as number) ?? undefined,
  });

  // Check if there are pending client tool calls (tools with no execute)
  const pendingToolCalls = result.steps
    .flatMap((step) => {
      return step.toolCalls ?? [];
    })
    .filter((tc) => {
      const resolvedTool = resolvedTools[tc.toolName];
      // Client tools don't have an execute function
      return resolvedTool && !('execute' in resolvedTool);
    });

  if (pendingToolCalls.length > 0) {
    traces.set(traceId, {
      id: traceId,
      projectId: typedAgent.project.id as number,
      agentId: args.agentId,
      status: 'requires_action',
      createdAt: new Date(),
      steps: result.steps as unknown[],
    });

    pendingGenerations.set(generationId, {
      agentId: args.agentId,
      projectId: typedAgent.project.id as number,
      traceId,
      generationId,
      pendingToolCalls: pendingToolCalls.map((tc) => {
        return {
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          args: tc.input,
        };
      }),
      messages: [...allMessages, ...result.response.messages],
      resolvedModel: model,
      agentConfig: {
        instructions: typedAgent.instructions,
        maxSteps: (typedAgent.maxSteps as number) ?? 20,
        toolChoice: typedAgent.toolChoice,
        stopConditions: typedAgent.stopConditions,
        activeToolIds: typedAgent.activeToolIds as string[] | null,
        stepRules: typedAgent.stepRules,
        temperature: typedAgent.temperature,
      },
      resolvedTools,
    });

    return {
      id: generationId,
      traceId,
      status: 'requires_action',
      requiredAction: {
        type: 'submit_tool_outputs',
        toolCalls: pendingToolCalls.map((tc) => {
          return {
            id: tc.toolCallId,
            toolName: tc.toolName,
            args: tc.input,
          };
        }),
      },
    };
  }

  traces.set(traceId, {
    id: traceId,
    projectId: typedAgent.project.id as number,
    agentId: args.agentId,
    status: 'completed',
    createdAt: new Date(),
    steps: result.steps as unknown[],
  });

  return {
    id: generationId,
    traceId,
    status: 'completed',
    output: {
      model: result.response?.modelId ?? typedAgent.model ?? '',
      content: result.text,
      finishReason: result.finishReason,
    },
  };
};

export const submitToolOutputs = async (args: {
  projectIds?: number[];
  agentId: string;
  generationId: string;
  toolOutputs: Array<{ toolCallId: string; output: unknown }>;
}): Promise<GenerationResult | 'not_found' | 'generation_not_found'> => {
  const pending = pendingGenerations.get(args.generationId);

  if (!pending || pending.agentId !== args.agentId) {
    return 'generation_not_found';
  }

  // Remove from pending
  pendingGenerations.delete(args.generationId);

  // Build tool result messages
  const toolResultMessages = args.toolOutputs.map((output) => {
    const pendingTool = pending.pendingToolCalls.find((tc) => {
      return tc.toolCallId === output.toolCallId;
    });
    return {
      role: 'tool' as const,
      content: [
        {
          type: 'tool-result' as const,
          toolCallId: output.toolCallId,
          toolName: pendingTool?.toolName ?? '',
          output: {
            type: 'text' as const,
            value:
              typeof output.output === 'string'
                ? output.output
                : JSON.stringify(output.output),
          },
        },
      ],
    };
  });

  const allMessages = [...pending.messages, ...toolResultMessages];

  const result = await generateText({
    model: pending.resolvedModel,
    messages: allMessages as ModelMessage[],
    tools:
      Object.keys(pending.resolvedTools).length > 0
        ? pending.resolvedTools
        : undefined,
    stopWhen: stepCountIs(pending.agentConfig.maxSteps),
    temperature: pending.agentConfig.temperature ?? undefined,
  });

  traces.set(pending.traceId, {
    id: pending.traceId,
    projectId: pending.projectId,
    agentId: pending.agentId,
    status: 'completed',
    createdAt: new Date(),
    steps: result.steps as unknown[],
  });

  return {
    id: args.generationId,
    traceId: pending.traceId,
    status: 'completed',
    output: {
      model: result.response?.modelId ?? '',
      content: result.text,
      finishReason: result.finishReason,
    },
  };
};

export const listTraces = async (_args: {
  projectIds?: number[];
}): Promise<Trace[]> => {
  const all = Array.from(traces.values());

  if (_args.projectIds === undefined) {
    return all;
  }

  return all.filter((trace) => {
    return _args.projectIds!.includes(trace.projectId);
  });
};

export const getTrace = async (args: {
  projectIds?: number[];
  traceId: string;
}): Promise<Trace | 'not_found'> => {
  const trace = traces.get(args.traceId);
  if (!trace) {
    return 'not_found';
  }

  if (
    args.projectIds !== undefined &&
    !args.projectIds.includes(trace.projectId)
  ) {
    return 'not_found';
  }

  return trace;
};
