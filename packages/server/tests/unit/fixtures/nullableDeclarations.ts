import { authenticatedTestClient } from '../testClient';
import type { FormationModuleFixtures } from './formationModules';

/**
 * Per formation type, declarations that together set every nullable property
 * of its `<Type>ResourceProperties` to a value an update may clear with `null`.
 * A property only another declared value makes valid to clear is in
 * `NOT_CLEARABLE_ALONE` instead, with what requires it.
 */
export type NullableFixtures = FormationModuleFixtures & {
  chatId: string;
  conversationId: string;
  guardrailId: string;
  secretId: string;
};

export const setupNullableFixtures = async (
  fx: FormationModuleFixtures
): Promise<NullableFixtures> => {
  const client = authenticatedTestClient(fx.adminToken);
  const created = async (path: string, body: object): Promise<string> => {
    const res = await client
      .post(`/api/v1/${path}`)
      .send({ project_id: fx.projectId, ...body });
    expect(res.status).toBe(201);
    return res.body.id;
  };
  return {
    ...fx,
    chatId: await created('chats', { ai_provider_id: fx.aiProviderId }),
    conversationId: await created('conversations', { name: 'Nullable Conv' }),
    guardrailId: await created('guardrails', {
      name: 'Nullable Guardrail',
      document: { class: 'A' },
    }),
    secretId: await created('secrets', { name: 'nullable', value: 'v' }),
  };
};

type Declaration = (
  fx: NullableFixtures,
  seed: string
) => Record<string, unknown>;

const DECIDER_QUESTIONS = [
  {
    type: 'predicate',
    name: 'needs_human',
    instructions: 'Must a person read this first?',
  },
];

export const DECLARATIONS: Record<string, Declaration[]> = {
  agent: [
    (fx) => {
      return {
        ai_provider_id: fx.aiProviderId,
        name: 'Nullable Agent',
        instructions: 'Be brief',
        model: 'gpt-4o',
        tool_bindings: [{ tool_id: fx.converterToolId }],
        max_steps: 10,
        stop_conditions: [
          { type: 'has_tool_call', tool_name: fx.converterToolName },
        ],
        active_tool_ids: [fx.converterToolId],
        guardrail_ids: [fx.guardrailId],
        step_rules: [{ step: 1, active_tool_ids: [fx.converterToolId] }],
        policy_ids: [fx.policyA],
        temperature: 0.5,
        max_context_messages: 20,
        max_output_tokens: 512,
        reasoning: { effort: 'low' },
        single_session_per_actor: true,
        trace_content_mode: 'full',
        on_approval_expiry: 'react',
        knowledge_config: { memory_store_ids: [fx.memoryStoreId], limit: 25 },
        output_schema: { type: 'object' },
        prompt_caching: { enabled: true },
        citation_config: { enabled: true },
      };
    },
    (fx) => {
      return {
        ai_provider_id: fx.aiProviderId,
        tool_bindings: [{ tool_id: fx.converterToolId }],
      };
    },
  ],
  actor: [
    (fx, seed) => {
      return {
        name: 'Nullable Actor',
        external_id: `ext-${seed}`,
        instructions: 'Be helpful',
        agent_id: fx.agentId,
      };
    },
    (fx) => {
      return { name: 'Nullable Chat Actor', chat_id: fx.chatId };
    },
  ],
  ai_provider: [
    (fx) => {
      return {
        name: 'Nullable Provider',
        provider: 'openai',
        default_model: 'gpt-4o',
        secret_id: fx.secretId,
        base_url: 'https://llm.example.com/v1',
        config: { organization: 'org' },
        model_aliases: { fast: 'gpt-4o-mini' },
      };
    },
  ],
  tool: [
    (fx) => {
      return {
        name: 'Nullable Client Tool',
        type: 'client',
        description: 'a client tool',
        parameters: { type: 'object' },
        context_keys: ['tenant'],
        output_mapping: { var: 'output' },
        guardrail_ids: [fx.guardrailId],
      };
    },
    () => {
      return {
        name: 'Nullable Builtin Tool',
        type: 'builtin',
        actions: ['list-tools', 'get-tool'],
        denied_actions: ['get-tool'],
        preset_parameters: { action: 'list-tools' },
        preset_parameters_by_action: { 'list-tools': { limit: 5 } },
      };
    },
  ],
  dataset: [
    () => {
      return { name: 'Nullable Suite', description: 'questions' };
    },
  ],
  dataset_item: [
    (fx) => {
      return {
        dataset_id: fx.datasetId,
        input: [{ role: 'user', content: 'capital of France?' }],
        expected_output: 'Paris',
      };
    },
  ],
  eval: [
    (fx) => {
      return {
        name: 'Nullable Eval',
        agent_id: fx.agentId,
        dataset_id: fx.datasetId,
        scorers: [{ type: 'exact_match', name: 'exact_match' }],
        pass_threshold: 0.8,
        group_by: 'topic',
      };
    },
  ],
  document: [
    (_fx, seed) => {
      return {
        content: 'a nullable document',
        path: `/nullable/${seed}.txt`,
        title: 'Doc',
        tags: { tier: 't1' },
      };
    },
    (_fx, seed) => {
      return { content: 'a nullable document', filename: `${seed}.txt` };
    },
  ],
  memory_store: [
    () => {
      return {
        name: 'Nullable Store',
        description: 'facts',
        duplicate_threshold: 0.95,
        supersede_threshold: 0.85,
      };
    },
  ],
  memory: [
    (fx) => {
      return {
        memory_store_id: fx.memoryStoreId,
        content: 'a fact',
        source_type: 'conversation',
        source_id: fx.conversationId,
      };
    },
  ],
  model_route: [
    (fx, seed) => {
      return {
        name: `nullable-${seed}`,
        targets: [{ ai_provider_id: fx.aiProviderId, model: 'gpt-4o' }],
        failure_threshold: 2,
        cooldown_seconds: 30,
      };
    },
  ],
  webhook: [
    (fx, seed) => {
      return {
        name: `Hook ${seed}`,
        description: 'a hook',
        url: 'https://example.com/hook',
        events: ['conversation.created'],
        event_resources: ['srn:*:conversation:*'],
        event_data: { status: 'open' },
        policy_ids: [fx.policyA],
      };
    },
  ],
  trigger: [
    (fx, seed) => {
      return {
        name: `Trigger ${seed}`,
        description: 'a trigger',
        type: 'manual',
        target_type: 'tool',
        target_id: fx.converterToolId,
        action: 'list-tools',
        input: { foo: 'bar' },
        tool_context: { tenant: 't1' },
        policy_ids: [fx.policyA],
      };
    },
    (fx, seed) => {
      return {
        name: `Event ${seed}`,
        type: 'event',
        target_type: 'agent',
        target_id: fx.agentId,
        events: ['agents.updated'],
        event_resources: ['*'],
        event_data: { status: 'ready' },
        policy_ids: [fx.policyB],
      };
    },
  ],
  conversation: [
    (fx) => {
      return { name: 'Nullable Conv', actor_id: fx.actorId };
    },
  ],
  file: [
    (_fx, seed) => {
      return {
        prefix: '/nullable',
        filename: `file-${seed}.txt`,
        content_type: 'text/plain',
        size: 1024,
      };
    },
  ],
  policy: [
    (fx, seed) => {
      return {
        name: `Pol ${seed}`,
        description: 'a policy',
        document: {
          statement: [
            {
              effect: 'Allow',
              action: ['tools:ListTools'],
              resource: [`srn:${fx.projectId}:*:*`],
            },
          ],
        },
      };
    },
  ],
  oauth_client: [
    (fx, seed) => {
      return {
        name: `Client ${seed}`,
        authorize_url: 'https://auth.example.com/authorize',
        token_url: 'https://auth.example.com/token',
        revocation_url: 'https://auth.example.com/revoke',
        client_id: `client-${seed}`,
        client_secret: `{{secret:${fx.secretId}}}`,
        scopes: ['read'],
        redirect_uri: 'https://app.example.com/callback',
        authorize_params: { prompt: 'consent' },
      };
    },
  ],
  session: [
    (fx) => {
      return {
        agent_id: fx.agentId,
        name: 'Nullable Session',
        actor_id: fx.actorId,
        max_context_messages: 20,
        tool_context: { tenant: 't1' },
      };
    },
  ],
  ingestion_rule: [
    (fx, seed) => {
      return {
        content_type_glob: `application/x-${seed}`,
        tool_id: fx.converterToolId,
        action: 'list-tools',
        preset_parameters: { action: 'list-tools' },
        native_extraction: 'skip',
        file_delivery: 'download_url',
        chunk_strategy: 'size',
        chunk_size: 800,
        chunk_overlap: 100,
      };
    },
  ],
  memory_rule: [
    (fx) => {
      return {
        memory_store_id: fx.memoryStoreId,
        on: 'generations.completed',
        source_agent_ids: [fx.agentId],
        prompt: 'Only deployment facts',
        ai_provider_id: fx.aiProviderId,
        model: 'gpt-4o',
      };
    },
    (fx) => {
      return {
        memory_store_id: fx.memoryStoreId,
        on: 'generations.completed',
        agent_id: fx.agentId,
      };
    },
    (fx) => {
      return {
        memory_store_id: fx.memoryStoreId,
        on: 'generations.completed',
        tool_id: fx.converterToolId,
        action: 'list-tools',
        preset_parameters: { action: 'list-tools' },
      };
    },
    (fx) => {
      return {
        memory_store_id: fx.memoryStoreId,
        on: 'generations.completed',
        tool_id: fx.converterToolId,
      };
    },
  ],
  orchestration: [
    () => {
      return {
        name: 'Nullable Squad',
        description: 'one step',
        nodes: [{ id: 'a', type: 'transform', expression: 1 }],
        edges: [],
        state_schema: { type: 'object' },
        input_schema: { type: 'object' },
        output_mapping: { result: { var: 'state' } },
      };
    },
  ],
  workflow: [
    (_fx, seed) => {
      return {
        name: `Workflow ${seed}`,
        description: 'a workflow',
        states: [
          { name: 'todo', initial: true },
          { name: 'done', terminal: true },
        ],
        transitions: [{ name: 'finish', from: ['todo'], to: 'done' }],
        payload_schema: { type: 'object' },
      };
    },
  ],
  collection: [
    (_fx, seed) => {
      return { name: `nullable-${seed}`, schema: { type: 'object' } };
    },
  ],
  guardrail: [
    (fx, seed) => {
      return {
        name: `Guardrail ${seed}`,
        description: 'a guardrail',
        class: 'B',
        default_class: 'C',
        guard: { '<': [1, 2] },
        escalate: true,
        context_tool_id: fx.converterToolId,
        context_mode: 'merge',
      };
    },
  ],
  decider: [
    (fx, seed) => {
      return {
        name: `decider-${seed}`,
        description: 'a decider',
        agent_id: fx.agentId,
        questions: DECIDER_QUESTIONS,
      };
    },
  ],
  playbook: [
    (fx, seed) => {
      return {
        name: `playbook-${seed}`,
        description: 'a playbook',
        definition: {
          nodes: [
            {
              id: 'lookup',
              title: 'Lookup',
              kind: 'execute',
              inputs: [],
              executor: { type: 'tool', id: fx.converterToolId },
            },
          ],
        },
      };
    },
  ],
};

const ONE_HANDLER = 'a rule names exactly one of `tool_id` or `agent_id`';
const ONE_BACKEND = 'a decider names exactly one of `agent_id` or `tool_id`';
const ONE_MODEL_SOURCE =
  'an agent binds `ai_provider_id` or `model_route_id` unless its project has a default route';

export const NOT_CLEARABLE_ALONE: Record<string, Record<string, string>> = {
  agent: { ai_provider_id: ONE_MODEL_SOURCE, model_route_id: ONE_MODEL_SOURCE },
  ingestion_rule: { tool_id: ONE_HANDLER, agent_id: ONE_HANDLER },
  decider: { agent_id: ONE_BACKEND, tool_id: ONE_BACKEND },
  tool: {
    actions: 'names every action `preset_parameters_by_action` keys',
    execute: 'required by `type: http`',
    mcp: 'required by `type: mcp`',
    pipeline: 'required by `type: pipeline`',
  },
  trigger: {
    cron: 'required by `type: schedule`',
    events: 'an event trigger names `events` or `event_pattern`',
    event_pattern: 'an event trigger names `events` or `event_pattern`',
  },
  quota: { scope_ref: 'required by every scope but `project`' },
};
