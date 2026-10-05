import {
  type FormationModuleFixtures,
  type RoundTripCase,
  runRoundTrip,
  setupFormationModuleFixtures,
} from '../../fixtures/formationModules';

// Every built-in resource type through the whole formation life: a deploy
// creates it, a plan reads it back through the module's own `read`, a changed
// declaration updates it, and a teardown removes it. A wrong field name or a
// missing normalization in any module surfaces as a plan that does not read
// back what was declared. Variants of these declarations are in
// `formationModulesVariants.test.ts`.

let fx: FormationModuleFixtures;

// Factories, so the fixture ids set in `beforeAll` are read at test time.
const CASES: RoundTripCase[] = [
  {
    name: 'chat',
    type: 'chat',
    route: 'chats',
    build: () => {
      return {
        create: {
          ai_provider_id: fx.aiProviderId,
          name: 'Chat A',
          model: 'gpt-4o',
        },
        expectRead: {
          ai_provider_id: fx.aiProviderId,
          name: 'Chat A',
          model: 'gpt-4o',
        },
      };
    },
  },
  {
    name: 'conversation linked to an actor',
    type: 'conversation',
    route: 'conversations',
    build: () => {
      return {
        create: { name: 'Conv A', actor_id: fx.actorId },
        expectRead: { name: 'Conv A', actor_id: fx.actorId },
        update: { name: 'Conv B', actor_id: fx.actorId, status: 'closed' },
        expectAfterUpdate: { name: 'Conv B', status: 'closed' },
      };
    },
  },
  {
    name: 'conversation',
    type: 'conversation',
    route: 'conversations',
    build: () => {
      return {
        create: { name: 'Conv C', status: 'open' },
        expectRead: { name: 'Conv C', status: 'open' },
      };
    },
  },
  {
    name: 'file',
    type: 'file',
    route: 'files',
    build: (seed) => {
      return {
        create: {
          prefix: '/docs',
          filename: `file-${seed}.txt`,
          content_type: 'text/plain',
          size: 1024,
          metadata: { owner: 'ops' },
        },
        expectRead: {
          prefix: '/docs',
          filename: `file-${seed}.txt`,
          content_type: 'text/plain',
          size: 1024,
        },
        update: {
          prefix: '/archive',
          filename: `renamed-${seed}.txt`,
          content_type: 'text/plain',
          size: 1024,
        },
        expectAfterUpdate: {
          prefix: '/archive',
          filename: `renamed-${seed}.txt`,
        },
      };
    },
  },
  {
    name: 'memory_store',
    type: 'memory_store',
    route: 'memory-stores',
    build: () => {
      return {
        create: {
          name: 'Mem A',
          description: 'a memory store',
          tags: { tier: 't1' },
        },
        expectRead: {
          name: 'Mem A',
          description: 'a memory store',
          tags: { tier: 't1' },
        },
        update: { name: 'Mem B', description: 'a memory store' },
        expectAfterUpdate: { name: 'Mem B' },
      };
    },
  },
  {
    name: 'policy',
    type: 'policy',
    route: 'policies',
    build: (seed) => {
      const document = {
        statement: [{ effect: 'Allow', action: ['tools:ListTools'] }],
      };
      return {
        create: { name: `Pol ${seed}`, description: 'a policy', document },
        expectRead: { name: `Pol ${seed}`, description: 'a policy' },
        update: {
          name: `Pol ${seed} updated`,
          description: 'still a policy',
          document,
        },
        expectAfterUpdate: {
          name: `Pol ${seed} updated`,
          description: 'still a policy',
        },
      };
    },
  },
  {
    name: 'memory',
    type: 'memory',
    route: 'memories',
    build: () => {
      return {
        create: { memory_store_id: fx.memoryStoreId, content: 'a fact' },
        expectRead: { content: 'a fact' },
        update: { memory_store_id: fx.memoryStoreId, content: 'a newer fact' },
        expectAfterUpdate: { content: 'a newer fact' },
      };
    },
  },
  {
    name: 'document',
    type: 'document',
    route: 'documents',
    build: () => {
      return {
        create: {
          content: 'a'.repeat(900),
          title: 'Doc A',
          chunk_strategy: 'size',
          chunk_size: 800,
          chunk_overlap: 120,
        },
        // The chunk fields read back, so a re-plan of the same template
        // converges instead of re-reporting them as changed.
        expectRead: {
          content: 'a'.repeat(900),
          title: 'Doc A',
          chunk_strategy: 'size',
          chunk_size: 800,
          chunk_overlap: 120,
        },
        update: { content: 'b'.repeat(900), chunk_strategy: 'whole' },
        expectAfterUpdate: {
          content: 'b'.repeat(900),
          chunk_strategy: 'whole',
        },
      };
    },
  },
  {
    name: 'api_key with policies',
    type: 'api_key',
    route: 'api-keys',
    build: () => {
      return {
        create: { name: 'Key A', policy_ids: [fx.policyA, fx.policyB] },
        expectRead: { name: 'Key A', policy_ids: [fx.policyA, fx.policyB] },
        update: { name: 'Key B', policy_ids: [fx.policyB] },
        expectAfterUpdate: { name: 'Key B', policy_ids: [fx.policyB] },
      };
    },
  },
  {
    name: 'api_key',
    type: 'api_key',
    route: 'api-keys',
    build: () => {
      return {
        create: { name: 'Key C' },
        expectRead: { name: 'Key C' },
      };
    },
  },
  {
    name: 'agent',
    type: 'agent',
    route: 'agents',
    build: () => {
      const declared = {
        ai_provider_id: fx.aiProviderId,
        name: 'Agent A',
        model: 'gpt-4o',
        max_steps: 10,
        tool_choice: 'auto',
        output_schema: {
          type: 'object',
          properties: { summary: { type: 'string' } },
        },
        knowledge_config: {
          memory_store_ids: [fx.memoryStoreId],
          write_memory_store_id: fx.memoryStoreId,
          limit: 25,
        },
        tool_bindings: [{ tool_id: fx.converterToolId }],
      };
      return {
        create: declared,
        expectRead: declared,
        update: { ...declared, name: 'Agent B' },
        expectAfterUpdate: { name: 'Agent B' },
      };
    },
  },
  {
    name: 'session',
    type: 'session',
    route: 'sessions',
    build: () => {
      return {
        create: { agent_id: fx.agentId, name: 'Sess A', auto_generate: true },
        expectRead: { name: 'Sess A', auto_generate: true },
        update: { agent_id: fx.agentId, name: 'Sess B', auto_generate: false },
        expectAfterUpdate: { name: 'Sess B', auto_generate: false },
      };
    },
  },
  {
    name: 'ingestion_rule',
    type: 'ingestion_rule',
    route: 'ingestion-rules',
    build: (seed) => {
      return {
        create: {
          content_type_glob: `application/${seed}`,
          agent_id: fx.agentId,
        },
        expectRead: {
          content_type_glob: `application/${seed}`,
          agent_id: fx.agentId,
        },
        update: {
          content_type_glob: `application/${seed}-v2`,
          agent_id: fx.agentId,
          chunk_strategy: 'whole',
        },
        expectAfterUpdate: {
          content_type_glob: `application/${seed}-v2`,
          chunk_strategy: 'whole',
        },
      };
    },
  },
  {
    name: 'memory_rule',
    type: 'memory_rule',
    route: 'memory-rules',
    build: () => {
      return {
        create: {
          memory_store_id: fx.memoryStoreId,
          on: 'agents.generation.completed',
          source_agent_ids: [fx.agentId],
          prompt: 'Only deployment facts',
        },
        expectRead: {
          memory_store_id: fx.memoryStoreId,
          on: 'agents.generation.completed',
          source_agent_ids: [fx.agentId],
          prompt: 'Only deployment facts',
          // No handler: the built-in extractor.
          agent_id: null,
          tool_id: null,
        },
        // `null` widens the selector back to every agent in the project.
        update: {
          memory_store_id: fx.memoryStoreId,
          on: 'agents.generation.completed',
          enabled: false,
          source_agent_ids: null,
          prompt: 'Only deployment facts',
        },
        expectAfterUpdate: {
          enabled: false,
          source_agent_ids: null,
          prompt: 'Only deployment facts',
        },
      };
    },
  },
  {
    name: 'memory_rule with an agent handler',
    type: 'memory_rule',
    route: 'memory-rules',
    build: () => {
      return {
        create: {
          memory_store_id: fx.memoryStoreId,
          on: 'agents.generation.completed',
          agent_id: fx.agentId,
        },
        expectRead: { memory_store_id: fx.memoryStoreId, agent_id: fx.agentId },
      };
    },
  },
  {
    name: 'ai_provider',
    type: 'ai_provider',
    route: 'ai-providers',
    build: () => {
      return {
        create: { name: 'Prov A', provider: 'openai', default_model: 'gpt-4o' },
        expectRead: {
          name: 'Prov A',
          provider: 'openai',
          default_model: 'gpt-4o',
        },
        update: { name: 'Prov B', provider: 'openai', default_model: 'gpt-4o' },
        expectAfterUpdate: { name: 'Prov B' },
      };
    },
  },
  {
    name: 'webhook',
    type: 'webhook',
    route: 'webhooks',
    build: (seed) => {
      return {
        create: {
          name: `Hook ${seed}`,
          url: 'https://example.com/hook',
          events: ['conversation.created'],
        },
        expectRead: {
          name: `Hook ${seed}`,
          url: 'https://example.com/hook',
          events: ['conversation.created'],
        },
        update: {
          name: `Hook ${seed} updated`,
          url: 'https://example.com/hook',
          events: ['conversation.created'],
        },
        expectAfterUpdate: { name: `Hook ${seed} updated` },
      };
    },
  },
  {
    name: 'actor',
    type: 'actor',
    route: 'actors',
    build: (seed) => {
      return {
        create: {
          name: 'Actor A',
          external_id: `ext_${seed}`,
          instructions: 'Be helpful',
          agent_id: fx.agentId,
        },
        expectRead: {
          name: 'Actor A',
          external_id: `ext_${seed}`,
          instructions: 'Be helpful',
        },
        update: { name: 'Actor B', external_id: `ext_${seed}` },
        expectAfterUpdate: { name: 'Actor B' },
      };
    },
  },
  {
    name: 'tool',
    type: 'tool',
    route: 'tools',
    build: () => {
      const declared = {
        name: 'Tool A',
        type: 'client',
        description: 'a client tool',
        parameters: {
          type: 'object',
          properties: { message: { type: 'string' } },
        },
      };
      return {
        create: declared,
        expectRead: {
          name: 'Tool A',
          type: 'client',
          description: 'a client tool',
        },
        update: { ...declared, description: 'updated description' },
        expectAfterUpdate: { description: 'updated description' },
      };
    },
  },
  {
    name: 'trigger',
    type: 'trigger',
    route: 'triggers',
    build: (seed) => {
      const declared = {
        name: `Trigger ${seed}`,
        type: 'manual',
        target_type: 'agent',
        target_id: fx.agentId,
        input: { foo: 'bar' },
      };
      return {
        create: declared,
        expectRead: { ...declared, active: true },
        update: { ...declared, name: `Trigger ${seed} updated`, active: false },
        expectAfterUpdate: { name: `Trigger ${seed} updated`, active: false },
      };
    },
  },
  {
    name: 'schedule trigger with a policy boundary',
    type: 'trigger',
    route: 'triggers',
    build: (seed) => {
      return {
        create: {
          name: `Schedule ${seed}`,
          type: 'schedule',
          target_type: 'agent',
          target_id: fx.agentId,
          cron: '0 8 * * *',
          policy_id: fx.policyA,
        },
        expectRead: {
          type: 'schedule',
          cron: '0 8 * * *',
          policy_id: fx.policyA,
        },
      };
    },
  },
  {
    name: 'workflow',
    type: 'workflow',
    route: 'workflows',
    build: (seed) => {
      const states = [
        { name: 'todo', initial: true, kind: 'human', stalled_after: 3600 },
        {
          name: 'working',
          on_enter: {
            dispatch: { kind: 'agent', agent_id: fx.agentId },
            on_complete: [
              {
                when: { '==': [{ var: 'result.ok' }, true] },
                transition: 'finish',
              },
            ],
          },
        },
        { name: 'done', terminal: true },
      ];
      const transitions = [
        { name: 'start', from: ['todo'], to: 'working' },
        {
          name: 'finish',
          from: ['working'],
          to: 'done',
          guard: { '==': [{ var: 'task.payload.approved' }, true] },
          requires_approval: true,
        },
      ];
      const declared = {
        name: `Workflow ${seed}`,
        description: 'a workflow',
        states,
        transitions,
        payload_schema: {
          type: 'object',
          required: ['approved'],
          properties: { approved: { type: 'boolean' } },
        },
      };
      return {
        create: declared,
        expectRead: declared,
        update: { ...declared, name: `Workflow ${seed} updated` },
        expectAfterUpdate: { name: `Workflow ${seed} updated` },
      };
    },
  },
  {
    name: 'guardrail',
    type: 'guardrail',
    route: 'guardrails',
    build: (seed) => {
      const declared = {
        name: `Guardrail ${seed}`,
        class: 'B',
        default_class: 'C',
        guard: { '<': [{ var: 'runtime.projects.cost_usd.24h' }, 1000] },
        escalate: true,
        context_tool_id: fx.converterToolId,
        context_mode: 'merge',
      };
      return {
        create: declared,
        expectRead: declared,
        // The document is one atomic write: a field the new declaration omits
        // is dropped, not merged.
        update: { name: `Guardrail ${seed} Updated`, class: 'C' },
        expectAfterUpdate: {
          name: `Guardrail ${seed} Updated`,
          class: 'C',
          default_class: null,
          guard: null,
          escalate: null,
        },
      };
    },
  },
  {
    name: 'metadata_schema',
    type: 'metadata_schema',
    route: 'metadata-schemas',
    build: () => {
      return {
        create: {
          resource_type: 'document',
          path_prefix: '/formation-reports',
          schema: { type: 'object', required: ['quarter'] },
        },
        expectRead: {
          resource_type: 'document',
          path_prefix: '/formation-reports',
          schema: { type: 'object', required: ['quarter'] },
        },
        update: {
          resource_type: 'document',
          path_prefix: '/formation-reports/quarterly',
          schema: { type: 'object', required: ['quarter', 'owner'] },
        },
        expectAfterUpdate: {
          path_prefix: '/formation-reports/quarterly',
          schema: { type: 'object', required: ['quarter', 'owner'] },
        },
      };
    },
  },
  {
    name: 'project quota',
    type: 'quota',
    route: 'quotas',
    build: () => {
      const declared = {
        scope: 'project',
        metric: 'cost_usd',
        window: 'calendar_month',
        limit: 25.5,
        mode: 'monitor',
      };
      return {
        create: declared,
        expectRead: { ...declared, scope_ref: null },
        update: { ...declared, limit: 40, mode: 'enforce' },
        expectAfterUpdate: { limit: 40, mode: 'enforce' },
      };
    },
  },
  {
    name: 'agent quota',
    type: 'quota',
    route: 'quotas',
    build: () => {
      return {
        create: {
          scope: 'agent',
          scope_ref: fx.agentId,
          metric: 'tokens',
          window: 'rolling_1h',
          limit: 1000,
        },
        expectRead: { scope: 'agent', scope_ref: fx.agentId, metric: 'tokens' },
      };
    },
  },
];

beforeAll(async () => {
  fx = await setupFormationModuleFixtures({ prefix: 'fmround' });
});

describe('a formation over every built-in resource type', () => {
  test.each(CASES)(
    '$name: deploy, read back, update, tear down',
    (testCase) => {
      return runRoundTrip({ fx, testCase });
    }
  );
});
