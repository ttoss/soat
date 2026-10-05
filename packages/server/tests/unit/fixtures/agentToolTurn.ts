import { authenticatedTestClient } from '../testClient';
import { setupProjectWithUsers } from './bootstrap';
import {
  proposeCalls,
  type ScriptedCall,
  type ScriptedModel,
  startScriptedModel,
  startToolTarget,
  type ToolTarget,
} from './scriptedModel';

export const AMOUNT_SCHEMA = {
  type: 'object',
  properties: { amount: { type: 'number' } },
};

export type GenerationBody = {
  id: string;
  status: string;
  output?: { content: string };
  required_action?: {
    tool_calls: Array<{
      id: string;
      tool_name: string;
      args: Record<string, unknown>;
    }>;
  };
};

type TurnProject = {
  adminToken: string;
  projectId: string;
  providerId: string;
  target: ToolTarget;
  unique: (prefix: string) => string;
};

const apiFor = (project: { adminToken: string }) => {
  return () => {
    return authenticatedTestClient(project.adminToken);
  };
};

const resourceBuilders = (project: TurnProject) => {
  const api = apiFor(project);

  const createGuardrail = async (
    document: object,
    extra: Record<string, unknown> = {}
  ): Promise<string> => {
    const res = await api()
      .post('/api/v1/guardrails')
      .send({
        project_id: project.projectId,
        name: project.unique('gate'),
        document,
        ...extra,
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  /** An `http` tool posting to its own path on the target. */
  const createTool = async (
    body: Record<string, unknown> = {}
  ): Promise<{ id: string; name: string }> => {
    const name =
      typeof body.name === 'string' ? body.name : project.unique('refund');
    const res = await api()
      .post('/api/v1/tools')
      .send({
        project_id: project.projectId,
        name,
        type: 'http',
        parameters: AMOUNT_SCHEMA,
        execute: { url: `${project.target.baseUrl}/${name}`, method: 'POST' },
        ...body,
      });
    expect(res.status).toBe(201);
    return { id: res.body.id, name };
  };

  const createAgent = async (
    body: Record<string, unknown>
  ): Promise<string> => {
    const res = await api()
      .post('/api/v1/agents')
      .send({
        project_id: project.projectId,
        ai_provider_id: project.providerId,
        name: project.unique('agent'),
        ...body,
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  /** A tool gated by `documents` at tool scope, bound to a fresh agent. */
  const gatedTool = async (gate: {
    documents: object[];
    tool?: Record<string, unknown>;
  }) => {
    const guardrailIds: string[] = [];
    for (const document of gate.documents) {
      guardrailIds.push(await createGuardrail(document));
    }
    const tool = await createTool({
      ...(guardrailIds.length > 0 ? { guardrail_ids: guardrailIds } : {}),
      ...gate.tool,
    });
    const agentId = await createAgent({
      tool_bindings: [{ tool_id: tool.id }],
    });
    return { ...tool, agentId, guardrailIds };
  };

  return { createGuardrail, createTool, createAgent, gatedTool };
};

type Turn = {
  agentId: string;
  calls: ScriptedCall[];
  body?: Record<string, unknown>;
};

const turnRunners = (project: { adminToken: string }) => {
  const api = apiFor(project);

  /** One waited turn in which the model proposes `calls`. */
  const startTurn = async (turn: Turn): Promise<GenerationBody> => {
    const res = await api()
      .post(`/api/v1/agents/${turn.agentId}/generate?wait=true`)
      .send({ messages: [proposeCalls(turn.calls)], ...turn.body });
    expect(res.status).toBe(200);
    return res.body;
  };

  /** A turn that completes; `results` is what each call returned to the model. */
  const generate = async (
    turn: Turn
  ): Promise<{ id: string; results: Array<Record<string, unknown>> }> => {
    const body = await startTurn(turn);
    expect(body.status).toBe('completed');
    return { id: body.id, results: JSON.parse(body.output?.content ?? '[]') };
  };

  return { startTurn, generate };
};

/**
 * A project whose agents run real turns against the scripted model, with tools
 * that call the recording target. Every resource gets a unique name, so the
 * tests sharing one harness never read each other's calls.
 */
export const startAgentToolTurn = async (args: { prefix: string }) => {
  const model: ScriptedModel = await startScriptedModel();
  const target: ToolTarget = await startToolTarget();
  const { adminToken, projectId } = await setupProjectWithUsers({
    prefix: args.prefix,
    policyActions: ['agents:GetAgent'],
    createNoPermUser: false,
  });
  const api = apiFor({ adminToken });
  let seq = 0;
  const unique = (prefix: string): string => {
    seq += 1;
    return `${prefix}-${seq}`;
  };

  const provider = await api()
    .post('/api/v1/ai-providers')
    .send({
      project_id: projectId,
      name: `${args.prefix}-provider`,
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: model.baseUrl,
    });
  expect(provider.status).toBe(201);
  const project: TurnProject = {
    adminToken,
    projectId,
    providerId: provider.body.id,
    target,
    unique,
  };

  return {
    model,
    target,
    adminToken,
    projectId,
    api,
    unique,
    ...resourceBuilders(project),
    ...turnRunners(project),
    close: async () => {
      await model.close();
      await target.close();
    },
  };
};

export type AgentToolTurn = Awaited<ReturnType<typeof startAgentToolTurn>>;

/** Polls a fire-and-forget side effect until `done` holds, or gives up. */
export const pollUntil = async <T>(args: {
  read: () => Promise<T>;
  done: (value: T) => boolean;
}): Promise<T> => {
  let value = await args.read();
  for (let attempt = 0; attempt < 80 && !args.done(value); attempt += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
    value = await args.read();
  }
  return value;
};
