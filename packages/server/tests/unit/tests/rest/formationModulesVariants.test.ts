import {
  type FormationModuleFixtures,
  nextSeed,
  planChange,
  type RoundTripCase,
  runRoundTrip,
  setupFormationModuleFixtures,
  templateOf,
} from '../../fixtures/formationModules';
import { authenticatedTestClient } from '../../testClient';

// Declarations beyond the plain shape of each type: optional fields left out,
// nullable ones cleared, a camelCase spelling, and the types whose lifecycle
// carries a parent or a graph. Each goes through the same round trip as
// `formationModulesRoundTrip.test.ts`.

let fx: FormationModuleFixtures;

const client = () => {
  return authenticatedTestClient(fx.adminToken);
};

const CASES: RoundTripCase[] = [
  {
    name: 'chat with only its provider',
    type: 'chat',
    route: 'chats',
    build: () => {
      return {
        create: { ai_provider_id: fx.aiProviderId },
        expectRead: { ai_provider_id: fx.aiProviderId },
      };
    },
  },
  {
    name: 'file with only a filename',
    type: 'file',
    route: 'files',
    build: (seed) => {
      return {
        create: { filename: `bare-${seed}.txt` },
        expectRead: { filename: `bare-${seed}.txt` },
        update: { filename: `bare-renamed-${seed}.txt` },
        expectAfterUpdate: { filename: `bare-renamed-${seed}.txt` },
      };
    },
  },
  {
    name: 'policy with only a document',
    type: 'policy',
    route: 'policies',
    build: () => {
      const document = {
        statement: [{ effect: 'Allow', action: ['agents:GetAgent'] }],
      };
      return {
        create: { document },
        expectRead: { document },
        update: {
          document: {
            statement: [{ effect: 'Allow', action: ['tools:ListTools'] }],
          },
        },
        expectAfterUpdate: {
          document: {
            statement: [{ effect: 'Allow', action: ['tools:ListTools'] }],
          },
        },
      };
    },
  },
  {
    name: 'session without optional fields',
    type: 'session',
    route: 'sessions',
    build: () => {
      return {
        create: { agent_id: fx.agentId },
        expectRead: { agent_id: fx.agentId },
        update: { agent_id: fx.agentId, name: 'Named Later' },
        expectAfterUpdate: { name: 'Named Later' },
      };
    },
  },
  {
    name: 'conversation renamed without a status',
    type: 'conversation',
    route: 'conversations',
    build: () => {
      return {
        create: { name: 'Conv D' },
        expectRead: { name: 'Conv D' },
        update: { name: 'Conv E' },
        expectAfterUpdate: { name: 'Conv E' },
      };
    },
  },
  {
    name: 'model_route',
    type: 'model_route',
    route: 'model-routes',
    build: (seed) => {
      const declared = {
        name: `route-${seed}`,
        targets: [
          { ai_provider_id: fx.aiProviderId, model: 'gpt-4o' },
          {
            ai_provider_id: fx.aiProviderId,
            model: 'gpt-4o-mini',
            max_retries: 1,
          },
        ],
        retry_on: ['provider_error', 'timeout'],
        failure_threshold: 2,
        cooldown_seconds: 30,
      };
      return {
        create: declared,
        expectRead: declared,
        update: {
          name: `route-${seed}`,
          targets: [{ ai_provider_id: fx.aiProviderId, model: 'gpt-4o-mini' }],
          retry_on: ['rate_limited'],
        },
        expectAfterUpdate: {
          targets: [{ ai_provider_id: fx.aiProviderId, model: 'gpt-4o-mini' }],
          retry_on: ['rate_limited'],
        },
      };
    },
  },
  {
    name: 'model_route with only a cooldown',
    type: 'model_route',
    route: 'model-routes',
    build: (seed) => {
      return {
        create: {
          name: `cooldown-${seed}`,
          targets: [{ ai_provider_id: fx.aiProviderId, model: 'gpt-4o' }],
          cooldown_seconds: 15,
        },
        // Declaring one breaker value is valid; the other takes its default.
        expectRead: { cooldown_seconds: 15, failure_threshold: 3 },
      };
    },
  },
  {
    name: 'orchestration',
    type: 'orchestration',
    route: 'orchestrations',
    build: () => {
      const declared = {
        name: 'Content Squad',
        description: 'writer then reviewer',
        nodes: [
          {
            id: 'write',
            type: 'agent',
            agent_id: fx.agentId,
            input_mapping: { prompt: { var: 'input.topic' } },
            state_mapping: { 'state.draft': { var: 'output.content' } },
          },
          {
            id: 'review',
            type: 'agent',
            agent_id: fx.agentId,
            input_mapping: { prompt: { var: 'draft' } },
            state_mapping: { 'state.review': { var: 'output.content' } },
          },
        ],
        edges: [{ from: 'write', to: 'review', activation_condition: 'all' }],
        input_schema: {
          type: 'object',
          properties: { topic: { type: 'string' } },
        },
      };
      return {
        create: declared,
        expectRead: declared,
        update: {
          name: 'Rewired Squad',
          nodes: [{ id: 'only', type: 'agent', agent_id: fx.agentId }],
          edges: [],
        },
        expectAfterUpdate: {
          name: 'Rewired Squad',
          nodes: [{ id: 'only', type: 'agent', agent_id: fx.agentId }],
        },
      };
    },
  },
  {
    name: 'dataset',
    type: 'dataset',
    route: 'datasets',
    build: () => {
      return {
        create: { name: 'Formation Suite', description: 'billing questions' },
        expectRead: {
          name: 'Formation Suite',
          description: 'billing questions',
        },
        update: { name: 'Formation Suite v2', description: null },
        expectAfterUpdate: { name: 'Formation Suite v2', description: null },
      };
    },
  },
  {
    name: 'dataset renamed without a description',
    type: 'dataset',
    route: 'datasets',
    build: () => {
      return {
        create: { name: 'Declared-Only Suite', description: 'keep me' },
        expectRead: { description: 'keep me' },
        // An omitted nullable field is left alone, not cleared.
        update: { name: 'Declared-Only Suite v2' },
        expectAfterUpdate: {
          name: 'Declared-Only Suite v2',
          description: 'keep me',
        },
      };
    },
  },
  {
    name: 'eval',
    type: 'eval',
    route: 'evals',
    build: () => {
      const declared = {
        name: 'Formation Eval',
        agent_id: fx.agentId,
        dataset_id: fx.datasetId,
        scorers: [{ type: 'exact_match' }],
        pass_threshold: 0.8,
      };
      return {
        create: declared,
        expectRead: declared,
        update: {
          ...declared,
          scorers: [{ type: 'contains', value: 'Paris' }],
          pass_threshold: 0.5,
        },
        expectAfterUpdate: {
          pass_threshold: 0.5,
          scorers: [{ type: 'contains', value: 'Paris' }],
        },
      };
    },
  },
  {
    name: 'eval without a pass_threshold',
    type: 'eval',
    route: 'evals',
    build: () => {
      const declared = {
        name: 'Declared-Only Eval',
        agent_id: fx.agentId,
        dataset_id: fx.datasetId,
        scorers: [{ type: 'exact_match' }],
        pass_threshold: 0.9,
      };
      const { pass_threshold: _kept, ...withoutThreshold } = declared;
      return {
        create: declared,
        expectRead: { pass_threshold: 0.9 },
        update: { ...withoutThreshold, name: 'Declared-Only Eval v2' },
        expectAfterUpdate: {
          name: 'Declared-Only Eval v2',
          pass_threshold: 0.9,
        },
      };
    },
  },
  {
    name: 'dataset_item',
    type: 'dataset_item',
    route: 'dataset-items',
    build: () => {
      return {
        create: {
          dataset_id: fx.datasetId,
          input: [{ role: 'user', content: 'capital of France?' }],
          expected_output: 'Paris',
          metadata: { topic: 'geography' },
        },
        expectRead: {
          dataset_id: fx.datasetId,
          input: [{ role: 'user', content: 'capital of France?' }],
          expected_output: 'Paris',
          metadata: { topic: 'geography' },
        },
        // Omitted nullable fields are left alone; an explicit null clears.
        update: {
          dataset_id: fx.datasetId,
          input: [{ role: 'user', content: 'capital of Italy?' }],
          metadata: null,
        },
        expectAfterUpdate: {
          input: [{ role: 'user', content: 'capital of Italy?' }],
          expected_output: 'Paris',
          metadata: null,
        },
      };
    },
  },
];

beforeAll(async () => {
  fx = await setupFormationModuleFixtures({ prefix: 'fmvariant' });
});

describe('a formation over a declaration variant', () => {
  test.each(CASES)(
    '$name: deploy, read back, update, tear down',
    (testCase) => {
      return runRoundTrip({ fx, testCase });
    }
  );
});

describe('a formation declared in camelCase', () => {
  // Every module reads the snake_case key the schema declares, so a camelCase
  // declaration must reach it under that spelling.
  const CAMEL: Array<{
    type: string;
    camel: (seed: string) => Record<string, unknown>;
    expectRead: (seed: string) => Record<string, unknown>;
  }> = [
    {
      type: 'chat',
      camel: () => {
        return { aiProviderId: fx.aiProviderId };
      },
      expectRead: () => {
        return { ai_provider_id: fx.aiProviderId };
      },
    },
    {
      type: 'file',
      camel: (seed) => {
        return { filename: `camel-${seed}.txt`, contentType: 'text/plain' };
      },
      expectRead: (seed) => {
        return {
          filename: `camel-${seed}.txt`,
          content_type: 'text/plain',
        };
      },
    },
    {
      type: 'memory',
      camel: () => {
        return { memoryStoreId: fx.memoryStoreId, content: 'camel fact' };
      },
      expectRead: () => {
        return { content: 'camel fact' };
      },
    },
    {
      type: 'agent',
      camel: () => {
        return {
          aiProviderId: fx.aiProviderId,
          name: 'Camel Agent',
          maxSteps: 7,
        };
      },
      expectRead: () => {
        return {
          ai_provider_id: fx.aiProviderId,
          name: 'Camel Agent',
          max_steps: 7,
        };
      },
    },
    {
      type: 'session',
      camel: () => {
        return { agentId: fx.agentId, autoGenerate: true };
      },
      expectRead: () => {
        return { auto_generate: true };
      },
    },
    {
      type: 'conversation',
      camel: () => {
        return { actorId: fx.actorId };
      },
      expectRead: () => {
        return { actor_id: fx.actorId };
      },
    },
    {
      type: 'api_key',
      camel: () => {
        return { name: 'Camel Key', policyIds: [fx.policyA] };
      },
      expectRead: () => {
        return { policy_ids: [fx.policyA] };
      },
    },
    {
      type: 'ai_provider',
      camel: () => {
        return {
          name: 'Camel Prov',
          provider: 'openai',
          defaultModel: 'gpt-4o',
        };
      },
      expectRead: () => {
        return { default_model: 'gpt-4o' };
      },
    },
    {
      type: 'guardrail',
      camel: (seed) => {
        return {
          name: `Guardrail Camel ${seed}`,
          class: 'A',
          defaultClass: 'C',
          contextToolId: fx.converterToolId,
        };
      },
      expectRead: (seed) => {
        return {
          name: `Guardrail Camel ${seed}`,
          default_class: 'C',
          context_tool_id: fx.converterToolId,
        };
      },
    },
    {
      type: 'memory_rule',
      camel: () => {
        return {
          memoryStoreId: fx.memoryStoreId,
          on: 'agents.generation.completed',
          agentId: fx.agentId,
        };
      },
      expectRead: () => {
        return {
          memory_store_id: fx.memoryStoreId,
          agent_id: fx.agentId,
        };
      },
    },
    {
      type: 'orchestration',
      camel: () => {
        return {
          name: 'Camel Squad',
          nodes: [{ id: 'a', type: 'transform', expression: 1 }],
          edges: [],
          stateSchema: { type: 'object' },
        };
      },
      expectRead: () => {
        return { state_schema: { type: 'object' } };
      },
    },
  ];

  test.each(CAMEL)('$type', async ({ type, camel, expectRead }) => {
    const seed = nextSeed();
    const created = await client()
      .post('/api/v1/formations')
      .send({
        project_id: fx.projectId,
        name: `camel-${seed}`,
        template: templateOf(type, camel(seed)),
      });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('active');

    const change = await planChange({
      fx,
      formationId: created.body.id,
      template: templateOf(type, camel(seed)),
    });

    expect(change.diff.current).toMatchObject(expectRead(seed));
  });
});

describe('PUT /api/v1/formations/:formation_id — a type with no update operation', () => {
  test('a changed chat declaration applies without touching the chat', async () => {
    const created = await client()
      .post('/api/v1/formations')
      .send({
        project_id: fx.projectId,
        name: `immutable-chat-${nextSeed()}`,
        template: templateOf('chat', {
          ai_provider_id: fx.aiProviderId,
          name: 'Fixed Name',
        }),
      });
    expect(created.status).toBe(201);
    const chatId: string = created.body.resources[0].physical_resource_id;

    const updated = await client()
      .put(`/api/v1/formations/${created.body.id}`)
      .send({
        template: templateOf('chat', {
          ai_provider_id: fx.aiProviderId,
          name: 'Another Name',
        }),
      });

    expect(updated.status).toBe(200);
    expect(updated.body.status).toBe('active');
    const chat = await client().get(`/api/v1/chats/${chatId}`);
    expect(chat.body.name).toBe('Fixed Name');
  });
});
