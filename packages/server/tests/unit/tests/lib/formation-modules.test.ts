import { db } from 'src/db';
import { getFormationModule } from 'src/lib/formationsRegistry';
import {
  applyCreateResource,
  applyDeleteResource,
  applyUpdateResource,
} from 'src/lib/formationsResourceHandlers';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

// Drives the adapters through the real `apply*Resource` entry points against the
// real database, verifying each write by reading it back through the module's
// own `read` — so a wrong field name or missing normalization fails rather than
// passing against a mock. Shared referenced resources are created once via REST.

let adminToken: string;
let projectId: string; // public id
let internalProjectId: number; // db primary key — what apply* expects
let aiProviderId: string;
let secretId: string;
let agentId: string;
let converterToolId: string;
let memoryId: string;
let actorId: string;

beforeAll(async () => {
  await testClient
    .post('/api/v1/users/bootstrap')
    .send({ username: 'fmadmin', password: 'supersecret' });
  adminToken = await loginAs('fmadmin', 'supersecret');
  const admin = authenticatedTestClient(adminToken);

  const projectRes = await admin
    .post('/api/v1/projects')
    .send({ name: 'Formation Modules Project' });
  projectId = projectRes.body.id;

  const project = await db.Project.findOne({ where: { publicId: projectId } });
  internalProjectId = project!.id as number;

  const secretRes = await admin
    .post('/api/v1/secrets')
    .send({ project_id: projectId, name: 'fm_secret', value: 'shhh' });
  secretId = secretRes.body.id;

  const providerRes = await admin.post('/api/v1/ai-providers').send({
    project_id: projectId,
    name: 'FM Provider',
    provider: 'openai',
    default_model: 'gpt-4o',
  });
  aiProviderId = providerRes.body.id;

  const agentRes = await admin.post('/api/v1/agents').send({
    project_id: projectId,
    ai_provider_id: aiProviderId,
    name: 'FM Agent',
  });
  agentId = agentRes.body.id;

  const toolRes = await admin.post('/api/v1/tools').send({
    project_id: projectId,
    name: 'fm-converter',
    type: 'builtin',
    description: 'converter tool',
    actions: ['list-tools'],
  });
  converterToolId = toolRes.body.id;

  const memoryRes = await admin
    .post('/api/v1/memories')
    .send({ project_id: projectId, name: 'FM Memory' });
  memoryId = memoryRes.body.id;

  const actorRes = await admin
    .post('/api/v1/actors')
    .send({ project_id: projectId, name: 'FM Actor' });
  actorId = actorRes.body.id;
});

// The apply* entry points accept an object. Deliberately passing a non-object
// to exercise the "must be an object" guard needs to funnel through `unknown`;
// casting *from* `unknown` to the declared type is allowed (it is neither
// `as any` nor `as unknown`), so individual cases stay clean.
const applyCreateRaw = (resourceType: string, properties: unknown) => {
  return applyCreateResource({
    resourceType,
    projectId: internalProjectId,
    resolvedProperties: properties as Record<string, unknown>,
  });
};

const applyUpdateRaw = (
  resourceType: string,
  physicalResourceId: string,
  properties: unknown
) => {
  return applyUpdateResource({
    resourceType,
    physicalResourceId,
    resolvedProperties: properties as Record<string, unknown>,
  });
};

const readModule = (resourceType: string) => {
  const module = getFormationModule({ resourceType });
  return module!;
};

// ── Registry ──────────────────────────────────────────────────────────────

describe('formationsRegistry', () => {
  test('getFormationModule returns undefined for unknown resource type', () => {
    expect(getFormationModule({ resourceType: 'nonexistent' })).toBeUndefined();
  });

  test('getFormationModule returns module for registered resource type', () => {
    const module = getFormationModule({ resourceType: 'api_key' });
    expect(module).toBeDefined();
    expect(module?.resourceType).toBe('api_key');
  });
});

// ── Non-object property guards (consolidated) ───────────────────────────────

// resourceType → the exact "must be an object" message the module reports.
const NON_OBJECT: Array<[string, string]> = [
  ['api_key', 'API key `properties` must be an object'],
  ['webhook', 'Webhook `properties` must be an object'],
  ['trigger', 'Trigger `properties` must be an object'],
  ['memory_entry', 'MemoryEntry `properties` must be an object'],
  ['chat', 'Chat `properties` must be an object'],
  ['conversation', 'Conversation `properties` must be an object'],
  ['file', 'File `properties` must be an object'],
  ['policy', 'Policy `properties` must be an object'],
  ['project_price', 'Project price `properties` must be an object'],
  ['quota', 'Quota `properties` must be an object'],
  ['secret', 'Secret `properties` must be an object'],
  ['session', 'Session `properties` must be an object'],
  ['ingestion_rule', 'Ingestion rule `properties` must be an object'],
  ['agent', 'Agent `properties` must be an object'],
  ['memory', 'Memory `properties` must be an object'],
  ['orchestration', 'Orchestration `properties` must be an object'],
  ['ai_provider', 'AI provider `properties` must be an object'],
  ['actor', 'Actor `properties` must be an object'],
  ['tool', 'Tool `properties` must be an object'],
  ['document', 'Document `properties` must be an object'],
  ['workflow', 'Workflow `properties` must be an object'],
  ['guardrail', 'Guardrail `properties` must be an object'],
  ['model_route', 'Model route `properties` must be an object'],
  ['dataset', 'Dataset `properties` must be an object'],
  ['dataset_item', 'DatasetItem `properties` must be an object'],
  ['eval', 'Eval `properties` must be an object'],
];

// Every module — including `document` since it now re-chunks on update —
// validates its `properties` on update too.
const UPDATE_NON_OBJECT = NON_OBJECT;

describe('non-object properties are rejected', () => {
  test.each(NON_OBJECT)('create %s', async (resourceType, message) => {
    await expect(applyCreateRaw(resourceType, null)).rejects.toThrow(message);
  });

  test.each(UPDATE_NON_OBJECT)('update %s', async (resourceType, message) => {
    await expect(applyUpdateRaw(resourceType, 'phys_1', null)).rejects.toThrow(
      message
    );
  });

  test.each(NON_OBJECT)(
    'validateProperties %s delegates to the internal validator',
    (resourceType, message) => {
      const basePath = `resources.<${resourceType}>.properties`;
      const errors = readModule(resourceType).validateProperties?.({
        properties: null,
        basePath,
      });
      expect(errors).toEqual([{ path: basePath, message }]);
    }
  );
});

// Property factories are functions so the shared fixture ids, set in
// `beforeAll`, are read at test time rather than at table construction.

type RoundTripSpec = {
  create: Record<string, unknown>;
  expectRead: Record<string, unknown>;
  // Optional camelCase variant — asserts the module normalizes camelCase keys
  // (as the caseTransform middleware stores them) back to snake_case.
  camel?: Record<string, unknown>;
  camelExpectRead?: Record<string, unknown>;
  // Optional update — updates the created resource and re-reads it.
  update?: Record<string, unknown>;
  expectAfterUpdate?: Record<string, unknown>;
};

type RoundTripCase = {
  resourceType: string;
  // `seed` is woven into any field carrying a uniqueness constraint (file path,
  // ingestion glob, actor external_id, …) so create/update/delete cases don't
  // collide when they each create a fresh resource. `build` is a function so
  // the shared fixture ids (set in `beforeAll`) are read at test time.
  build: (seed: string) => RoundTripSpec;
};

const CASES: RoundTripCase[] = [
  {
    resourceType: 'chat',
    build: () => {
      return {
        create: {
          ai_provider_id: aiProviderId,
          name: 'Chat A',
          model: 'gpt-4o',
        },
        expectRead: {
          ai_provider_id: aiProviderId,
          name: 'Chat A',
          model: 'gpt-4o',
        },
        camel: { aiProviderId },
        camelExpectRead: { ai_provider_id: aiProviderId },
      };
    },
  },
  {
    resourceType: 'conversation',
    build: () => {
      return {
        create: { name: 'Conv A' },
        expectRead: { name: 'Conv A' },
        update: { name: 'Conv B' },
        expectAfterUpdate: { name: 'Conv B' },
      };
    },
  },
  {
    resourceType: 'file',
    build: (seed) => {
      return {
        create: { prefix: '/docs', filename: `file-${seed}.txt`, size: 1024 },
        expectRead: {
          prefix: '/docs',
          filename: `file-${seed}.txt`,
          size: 1024,
        },
        camel: { filename: `camel-${seed}.txt`, contentType: 'text/plain' },
        camelExpectRead: {
          filename: `camel-${seed}.txt`,
          content_type: 'text/plain',
        },
        update: { filename: `renamed-${seed}.txt` },
        expectAfterUpdate: { filename: `renamed-${seed}.txt` },
      };
    },
  },
  {
    resourceType: 'memory',
    build: () => {
      return {
        create: { name: 'Mem A', description: 'a memory', tags: ['t1'] },
        expectRead: { name: 'Mem A', description: 'a memory', tags: ['t1'] },
        update: { name: 'Mem B' },
        expectAfterUpdate: { name: 'Mem B' },
      };
    },
  },
  {
    resourceType: 'policy',
    build: (seed) => {
      const document = {
        statement: [{ effect: 'Allow', action: ['tools:ListTools'] }],
      };
      return {
        create: { name: `Pol ${seed}`, description: 'a policy', document },
        expectRead: { name: `Pol ${seed}`, description: 'a policy' },
        // Policy update revalidates the document, so it must be resent.
        update: { name: `Pol ${seed} updated`, document },
        expectAfterUpdate: { name: `Pol ${seed} updated` },
      };
    },
  },
  {
    resourceType: 'memory_entry',
    build: () => {
      return {
        create: { memory_id: memoryId, content: 'a fact' },
        expectRead: { content: 'a fact' },
        camel: { memoryId, content: 'camel fact' },
        camelExpectRead: { content: 'camel fact' },
      };
    },
  },
  {
    resourceType: 'document',
    build: () => {
      // Long content so `chunk_strategy: size` (size=800) actually splits into
      // more than one chunk — the F-13 repro condition. The three chunk fields
      // must round-trip through `read` so a re-plan of the same template is a
      // no-op instead of perpetually re-reporting them as changed.
      const content = 'a'.repeat(900);
      const updatedContent = 'b'.repeat(900);
      return {
        create: {
          content,
          title: 'Doc A',
          chunk_strategy: 'size',
          chunk_size: 800,
          chunk_overlap: 120,
        },
        expectRead: {
          content,
          title: 'Doc A',
          chunk_strategy: 'size',
          chunk_size: 800,
          chunk_overlap: 120,
        },
        // Changing the strategy on update must re-chunk (honored, not a no-op)
        // and read back the new strategy so the plan converges.
        update: { content: updatedContent, chunk_strategy: 'whole' },
        expectAfterUpdate: {
          content: updatedContent,
          chunk_strategy: 'whole',
        },
      };
    },
  },
  {
    resourceType: 'api_key',
    build: () => {
      return {
        create: { name: 'Key A' },
        expectRead: { name: 'Key A' },
        update: { name: 'Key B' },
        expectAfterUpdate: { name: 'Key B' },
      };
    },
  },
  {
    resourceType: 'agent',
    build: () => {
      return {
        create: {
          ai_provider_id: aiProviderId,
          name: 'Agent A',
          model: 'gpt-4o',
          max_steps: 10,
          tool_choice: 'auto',
          output_schema: {
            type: 'object',
            properties: { summary: { type: 'string' } },
          },
          // Formation templates author `knowledge_config` in snake_case, and
          // `template` bypasses caseTransformMiddleware (a deliberate
          // skip-key), so this exercises the create-side normalization to
          // camelCase directly — not just via the REST middleware.
          knowledge_config: {
            memory_ids: [memoryId],
            write_memory_id: memoryId,
            limit: 25,
            extraction: { enabled: true, model: 'llama3.2:1b' },
          },
        },
        expectRead: {
          ai_provider_id: aiProviderId,
          name: 'Agent A',
          model: 'gpt-4o',
          max_steps: 10,
          tool_choice: 'auto',
          output_schema: {
            type: 'object',
            properties: { summary: { type: 'string' } },
          },
          knowledge_config: {
            memory_ids: [memoryId],
            write_memory_id: memoryId,
            limit: 25,
            extraction: { enabled: true, model: 'llama3.2:1b' },
          },
        },
        // Agent templates must accept camelCase top-level keys like every
        // other resource — `aiProviderId`/`maxSteps` normalize to snake_case.
        camel: {
          aiProviderId,
          name: 'Camel Agent',
          maxSteps: 7,
        },
        camelExpectRead: {
          ai_provider_id: aiProviderId,
          name: 'Camel Agent',
          max_steps: 7,
        },
        update: { name: 'Agent B' },
        expectAfterUpdate: { name: 'Agent B' },
      };
    },
  },
  {
    resourceType: 'session',
    build: () => {
      return {
        create: { agent_id: agentId, name: 'Sess A' },
        expectRead: { name: 'Sess A' },
        camel: { agentId, autoGenerate: true },
        camelExpectRead: { auto_generate: true },
        update: { name: 'Sess B' },
        expectAfterUpdate: { name: 'Sess B' },
      };
    },
  },
  {
    resourceType: 'ingestion_rule',
    build: (seed) => {
      return {
        create: { content_type_glob: `application/${seed}`, agent_id: agentId },
        expectRead: {
          content_type_glob: `application/${seed}`,
          agent_id: agentId,
        },
        update: { chunk_strategy: 'whole' },
        expectAfterUpdate: { chunk_strategy: 'whole' },
      };
    },
  },
  {
    resourceType: 'ai_provider',
    build: () => {
      return {
        create: { name: 'Prov A', provider: 'openai', default_model: 'gpt-4o' },
        expectRead: {
          name: 'Prov A',
          provider: 'openai',
          default_model: 'gpt-4o',
        },
        camel: {
          name: 'Camel Prov',
          provider: 'openai',
          defaultModel: 'gpt-4o',
        },
        camelExpectRead: { default_model: 'gpt-4o' },
        update: { name: 'Prov B' },
        expectAfterUpdate: { name: 'Prov B' },
      };
    },
  },
  {
    resourceType: 'webhook',
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
        update: { name: `Hook ${seed} updated` },
        expectAfterUpdate: { name: `Hook ${seed} updated` },
      };
    },
  },
  {
    resourceType: 'actor',
    build: (seed) => {
      return {
        create: {
          name: 'Actor A',
          external_id: `ext_${seed}`,
          instructions: 'Be helpful',
          agent_id: agentId,
        },
        expectRead: {
          name: 'Actor A',
          external_id: `ext_${seed}`,
          instructions: 'Be helpful',
        },
        update: { name: 'Actor B' },
        expectAfterUpdate: { name: 'Actor B' },
      };
    },
  },
  {
    resourceType: 'tool',
    build: () => {
      return {
        create: {
          name: 'Tool A',
          type: 'client',
          description: 'a client tool',
          parameters: {
            type: 'object',
            properties: { message: { type: 'string' } },
          },
        },
        expectRead: {
          name: 'Tool A',
          type: 'client',
          description: 'a client tool',
        },
        update: { description: 'updated description' },
        expectAfterUpdate: { description: 'updated description' },
      };
    },
  },
  {
    resourceType: 'trigger',
    build: (seed) => {
      return {
        create: {
          name: `Trigger ${seed}`,
          type: 'manual',
          target_type: 'agent',
          target_id: agentId,
          input: { foo: 'bar' },
        },
        expectRead: {
          name: `Trigger ${seed}`,
          type: 'manual',
          target_type: 'agent',
          target_id: agentId,
          input: { foo: 'bar' },
          active: true,
        },
        update: { name: `Trigger ${seed} updated`, active: false },
        expectAfterUpdate: { name: `Trigger ${seed} updated`, active: false },
      };
    },
  },
  {
    resourceType: 'workflow',
    build: (seed) => {
      // Exercises the nested state/transition key conversion while a JSON-Logic
      // `guard` body round-trips verbatim.
      const states = [
        { name: 'todo', initial: true, kind: 'human', stalled_after: 3600 },
        {
          name: 'working',
          on_enter: {
            dispatch: { kind: 'agent', agent_id: agentId },
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
      return {
        create: {
          name: `Workflow ${seed}`,
          description: 'a workflow',
          states,
          transitions,
          payload_schema: {
            type: 'object',
            required: ['approved'],
            properties: { approved: { type: 'boolean' } },
          },
        },
        expectRead: {
          name: `Workflow ${seed}`,
          description: 'a workflow',
          states,
          transitions,
          payload_schema: {
            type: 'object',
            required: ['approved'],
            properties: { approved: { type: 'boolean' } },
          },
        },
        // Workflow templates must accept camelCase top-level keys too.
        camel: {
          name: `Camel Workflow ${seed}`,
          states: [{ name: 'only', initial: true }],
          transitions: [],
        },
        camelExpectRead: {
          name: `Camel Workflow ${seed}`,
          states: [{ name: 'only', initial: true }],
        },
        update: { name: `Workflow ${seed} updated` },
        expectAfterUpdate: { name: `Workflow ${seed} updated` },
      };
    },
  },
  {
    resourceType: 'guardrail',
    build: (seed) => {
      return {
        create: {
          name: `Guardrail ${seed}`,
          class: 'B',
          default_class: 'C',
          guard: { '<': [{ var: 'runtime.usage.cost_usd_24h' }, 1000] },
          escalate: true,
          context_tool_id: converterToolId,
          context_mode: 'merge',
        },
        expectRead: {
          name: `Guardrail ${seed}`,
          class: 'B',
          default_class: 'C',
          guard: { '<': [{ var: 'runtime.usage.cost_usd_24h' }, 1000] },
          escalate: true,
          context_tool_id: converterToolId,
          context_mode: 'merge',
        },
        camel: {
          name: `Guardrail Camel ${seed}`,
          class: 'A',
          defaultClass: 'C',
          contextToolId: converterToolId,
        },
        camelExpectRead: {
          name: `Guardrail Camel ${seed}`,
          class: 'A',
          default_class: 'C',
          context_tool_id: converterToolId,
        },
        // Only `class` is re-sent on update — the document is a single atomic
        // write, so previously set default_class/guard/escalate are dropped
        // rather than merged (matches `updateGuardrail`'s full-replace
        // contract for `document`).
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
];

let seedCounter = 0;
const nextSeed = (): string => {
  seedCounter += 1;
  return `s${seedCounter}`;
};

describe('formation module create → read round-trips', () => {
  test.each(CASES)('$resourceType create + read', async (testCase) => {
    const spec = testCase.build(nextSeed());
    const physicalId = await applyCreateResource({
      resourceType: testCase.resourceType,
      projectId: internalProjectId,
      resolvedProperties: spec.create,
    });
    expect(typeof physicalId).toBe('string');

    const read = await readModule(testCase.resourceType).read?.({
      physicalResourceId: physicalId,
    });
    expect(read).toMatchObject(spec.expectRead);
  });

  const camelCases = CASES.filter((testCase) => {
    return testCase.build('probe').camel !== undefined;
  });

  test.each(camelCases)(
    '$resourceType normalizes camelCase property keys',
    async (testCase) => {
      const spec = testCase.build(nextSeed());
      const physicalId = await applyCreateResource({
        resourceType: testCase.resourceType,
        projectId: internalProjectId,
        resolvedProperties: spec.camel!,
      });

      const read = await readModule(testCase.resourceType).read?.({
        physicalResourceId: physicalId,
      });
      expect(read).toMatchObject(spec.camelExpectRead!);
    }
  );

  const updateCases = CASES.filter((testCase) => {
    return testCase.build('probe').update !== undefined;
  });

  test.each(updateCases)('$resourceType update + read', async (testCase) => {
    const spec = testCase.build(nextSeed());
    const physicalId = await applyCreateResource({
      resourceType: testCase.resourceType,
      projectId: internalProjectId,
      resolvedProperties: spec.create,
    });

    await applyUpdateResource({
      resourceType: testCase.resourceType,
      physicalResourceId: physicalId,
      resolvedProperties: spec.update!,
    });

    const read = await readModule(testCase.resourceType).read?.({
      physicalResourceId: physicalId,
    });
    expect(read).toMatchObject(spec.expectAfterUpdate!);
  });

  test.each(CASES)(
    '$resourceType delete then read is null',
    async (testCase) => {
      const spec = testCase.build(nextSeed());
      const physicalId = await applyCreateResource({
        resourceType: testCase.resourceType,
        projectId: internalProjectId,
        resolvedProperties: spec.create,
      });

      await applyDeleteResource({
        resourceType: testCase.resourceType,
        physicalResourceId: physicalId,
      });

      const read = await readModule(testCase.resourceType).read?.({
        physicalResourceId: physicalId,
      });
      expect(read).toBeNull();
    }
  );

  test.each(CASES)(
    '$resourceType read returns null for a missing id',
    async (testCase) => {
      const read = await readModule(testCase.resourceType).read?.({
        physicalResourceId: `${testCase.resourceType}_missing_zzz`,
      });
      expect(read).toBeNull();
    }
  );
});

// ── chat immutable-update no-op ─────────────────────────────────────────────

describe('immutable update no-ops', () => {
  test('chat update validates but performs no operation', async () => {
    const chatId = await applyCreateResource({
      resourceType: 'chat',
      projectId: internalProjectId,
      resolvedProperties: { ai_provider_id: aiProviderId },
    });

    await expect(
      applyUpdateResource({
        resourceType: 'chat',
        physicalResourceId: chatId,
        resolvedProperties: {},
      })
    ).resolves.toBeUndefined();
  });
});

// ── document chunk strategy pass-through ────────────────────────────────────

describe('documentsFormationModule chunking', () => {
  const countChunks = async (physicalId: string): Promise<number> => {
    const doc = await db.Document.findOne({ where: { publicId: physicalId } });
    return db.DocumentChunk.count({ where: { documentId: doc!.id } });
  };

  test('create passes snake_case chunk_strategy/size/overlap to the documents API', async () => {
    const physicalId = await applyCreateResource({
      resourceType: 'document',
      projectId: internalProjectId,
      resolvedProperties: {
        content: 'a'.repeat(2500),
        title: 'Chunked Doc',
        chunk_strategy: 'size',
        chunk_size: 1000,
        chunk_overlap: 0,
      },
    });

    // 2500 chars / 1000 step (no overlap) => 3 chunks
    expect(await countChunks(physicalId)).toBe(3);
  });

  test('create normalizes camelCase chunk keys', async () => {
    const physicalId = await applyCreateResource({
      resourceType: 'document',
      projectId: internalProjectId,
      resolvedProperties: {
        content: 'b'.repeat(2500),
        chunkStrategy: 'size',
        chunkSize: 1000,
        chunkOverlap: 0,
      },
    });

    expect(await countChunks(physicalId)).toBe(3);
  });

  test('defaults to the whole strategy (one chunk) when omitted', async () => {
    const physicalId = await applyCreateResource({
      resourceType: 'document',
      projectId: internalProjectId,
      resolvedProperties: { content: 'c'.repeat(2500) },
    });

    expect(await countChunks(physicalId)).toBe(1);
  });

  test('update re-chunks when chunk_strategy changes', async () => {
    const physicalId = await applyCreateResource({
      resourceType: 'document',
      projectId: internalProjectId,
      resolvedProperties: {
        content: 'd'.repeat(2500),
        chunk_strategy: 'size',
        chunk_size: 1000,
        chunk_overlap: 0,
      },
    });
    // 2500 chars / 1000 step (no overlap) => 3 chunks
    expect(await countChunks(physicalId)).toBe(3);

    await applyUpdateResource({
      resourceType: 'document',
      physicalResourceId: physicalId,
      resolvedProperties: {
        content: 'd'.repeat(2500),
        chunk_strategy: 'whole',
      },
    });

    // Switching to `whole` collapses the document back to a single chunk.
    expect(await countChunks(physicalId)).toBe(1);
  });
});

// A quota is unique per (project, scope, scope_ref, metric, window), so it
// cannot ride the shared round-trip table, which re-creates each resource
// several times in one project.

describe('quotasFormationModule', () => {
  test('create → read → update → delete lifecycle (project scope)', async () => {
    const quotaId = await applyCreateResource({
      resourceType: 'quota',
      projectId: internalProjectId,
      resolvedProperties: {
        scope: 'project',
        metric: 'cost_usd',
        window: 'calendar_month',
        limit: 25.5,
        mode: 'monitor',
      },
    });
    expect(quotaId).toMatch(/^quota_/);

    const read = await readModule('quota').read?.({
      physicalResourceId: quotaId,
    });
    expect(read).toMatchObject({
      scope: 'project',
      scope_ref: null,
      metric: 'cost_usd',
      window: 'calendar_month',
      limit: 25.5,
      mode: 'monitor',
    });

    // Only limit/mode are mutable; the immutable fields are re-sent verbatim.
    await applyUpdateResource({
      resourceType: 'quota',
      physicalResourceId: quotaId,
      resolvedProperties: {
        scope: 'project',
        metric: 'cost_usd',
        window: 'calendar_month',
        limit: 40,
        mode: 'enforce',
      },
    });
    const afterUpdate = await readModule('quota').read?.({
      physicalResourceId: quotaId,
    });
    expect(afterUpdate).toMatchObject({ limit: 40, mode: 'enforce' });

    await applyDeleteResource({
      resourceType: 'quota',
      physicalResourceId: quotaId,
    });
    expect(
      await readModule('quota').read?.({ physicalResourceId: quotaId })
    ).toBeNull();
  });

  test('create resolves an agent scope_ref', async () => {
    const quotaId = await applyCreateResource({
      resourceType: 'quota',
      projectId: internalProjectId,
      resolvedProperties: {
        scope: 'agent',
        scope_ref: agentId,
        metric: 'tokens',
        window: 'rolling_1h',
        limit: 1000,
      },
    });
    const read = await readModule('quota').read?.({
      physicalResourceId: quotaId,
    });
    expect(read).toMatchObject({
      scope: 'agent',
      scope_ref: agentId,
      metric: 'tokens',
    });
    await applyDeleteResource({
      resourceType: 'quota',
      physicalResourceId: quotaId,
    });
  });

  test('read returns null for a missing quota', async () => {
    expect(
      await readModule('quota').read?.({
        physicalResourceId: 'quota_missing_zzz',
      })
    ).toBeNull();
  });
});

// ── api_key policy references ───────────────────────────────────────────────

describe('apiKeysFormationModule', () => {
  let policyA: string;
  let policyB: string;

  beforeAll(async () => {
    const admin = authenticatedTestClient(adminToken);
    policyA = (
      await admin.post('/api/v1/policies').send({
        document: {
          statement: [{ effect: 'Allow', action: ['tools:ListTools'] }],
        },
      })
    ).body.id;
    policyB = (
      await admin.post('/api/v1/policies').send({
        document: {
          statement: [{ effect: 'Allow', action: ['agents:GetAgent'] }],
        },
      })
    ).body.id;
  });

  test('create resolves policy_ids and read returns them', async () => {
    const keyId = await applyCreateResource({
      resourceType: 'api_key',
      projectId: internalProjectId,
      resolvedProperties: {
        name: 'Scoped Key',
        policy_ids: [policyA, policyB],
      },
    });

    const read = await readModule('api_key').read?.({
      physicalResourceId: keyId,
    });
    expect(read).toMatchObject({ name: 'Scoped Key' });
    expect((read as { policy_ids: string[] }).policy_ids).toEqual(
      expect.arrayContaining([policyA, policyB])
    );
  });

  test('create normalizes a camelCase policyIds key', async () => {
    const keyId = await applyCreateResource({
      resourceType: 'api_key',
      projectId: internalProjectId,
      resolvedProperties: { name: 'Camel Key', policyIds: [policyA] },
    });

    const read = await readModule('api_key').read?.({
      physicalResourceId: keyId,
    });
    expect((read as { policy_ids: string[] }).policy_ids).toEqual([policyA]);
  });

  test('update replaces the policy set', async () => {
    const keyId = await applyCreateResource({
      resourceType: 'api_key',
      projectId: internalProjectId,
      resolvedProperties: { name: 'Rescoped Key', policy_ids: [policyA] },
    });

    await applyUpdateResource({
      resourceType: 'api_key',
      physicalResourceId: keyId,
      resolvedProperties: { policy_ids: [policyB] },
    });

    const read = await readModule('api_key').read?.({
      physicalResourceId: keyId,
    });
    expect((read as { policy_ids: string[] }).policy_ids).toEqual([policyB]);
  });
});

// ── trigger starter/target + secret + shape rules ───────────────────────────

describe('triggersFormationModule', () => {
  test('webhook trigger exposes its signing secret via getAttributes', async () => {
    const id = await applyCreateResource({
      resourceType: 'trigger',
      projectId: internalProjectId,
      resolvedProperties: {
        name: 'FM Webhook Trigger',
        type: 'webhook',
        target_type: 'agent',
        target_id: agentId,
      },
    });

    const attrs = await readModule('trigger').getAttributes?.({
      physicalResourceId: id,
    });
    expect(typeof attrs?.secret).toBe('string');
    expect(attrs?.secret.length).toBeGreaterThan(0);
  });

  test('a non-webhook trigger exposes no secret attribute', async () => {
    const id = await applyCreateResource({
      resourceType: 'trigger',
      projectId: internalProjectId,
      resolvedProperties: {
        name: 'FM Manual Trigger NoSecret',
        type: 'manual',
        target_type: 'agent',
        target_id: agentId,
      },
    });

    const attrs = await readModule('trigger').getAttributes?.({
      physicalResourceId: id,
    });
    expect(attrs).toEqual({});
  });

  test('schedule trigger create computes next_fire_at and reads back cron', async () => {
    const id = await applyCreateResource({
      resourceType: 'trigger',
      projectId: internalProjectId,
      resolvedProperties: {
        name: 'FM Schedule Trigger',
        type: 'schedule',
        target_type: 'agent',
        target_id: agentId,
        cron: '0 8 * * *',
      },
    });

    const read = await readModule('trigger').read?.({ physicalResourceId: id });
    expect(read).toMatchObject({ type: 'schedule', cron: '0 8 * * *' });
  });

  test('create resolves a policy_id boundary and read returns it', async () => {
    const policyId = (
      await authenticatedTestClient(adminToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [
              { effect: 'Allow', action: ['agents:CreateAgentGeneration'] },
            ],
          },
        })
    ).body.id;

    const id = await applyCreateResource({
      resourceType: 'trigger',
      projectId: internalProjectId,
      resolvedProperties: {
        name: 'FM Policy Trigger',
        type: 'manual',
        target_type: 'agent',
        target_id: agentId,
        policy_id: policyId,
      },
    });

    const read = await readModule('trigger').read?.({ physicalResourceId: id });
    expect(read).toMatchObject({ policy_id: policyId });
  });

  test('validateProperties rejects cron on a non-schedule trigger', () => {
    const errors = readModule('trigger').validateProperties?.({
      properties: {
        name: 'Bad',
        type: 'manual',
        target_type: 'agent',
        target_id: agentId,
        cron: '0 8 * * *',
      },
      basePath: 'resources.<trigger>.properties',
    });
    expect(errors?.length).toBeGreaterThan(0);
    expect(errors?.[0].message).toMatch(/cron is only valid for schedule/i);
  });

  test('validateProperties rejects an unparseable cron on a schedule trigger', () => {
    const errors = readModule('trigger').validateProperties?.({
      properties: {
        name: 'Bad',
        type: 'schedule',
        target_type: 'agent',
        target_id: agentId,
        cron: 'not a cron',
      },
      basePath: 'resources.<trigger>.properties',
    });
    expect(errors?.length).toBeGreaterThan(0);
  });

  test('validateProperties rejects an action on a non-tool target', () => {
    const errors = readModule('trigger').validateProperties?.({
      properties: {
        name: 'Bad',
        type: 'manual',
        target_type: 'agent',
        target_id: agentId,
        action: 'do-thing',
      },
      basePath: 'resources.<trigger>.properties',
    });
    expect(errors?.length).toBeGreaterThan(0);
    expect(errors?.[0].message).toMatch(/action is only valid for tool/i);
  });
});

// ── conversation actor link ─────────────────────────────────────────────────

describe('conversationsFormationModule', () => {
  test('create links an actor_id and read returns it', async () => {
    const convId = await applyCreateResource({
      resourceType: 'conversation',
      projectId: internalProjectId,
      resolvedProperties: { name: 'Linked', actor_id: actorId },
    });

    const read = await readModule('conversation').read?.({
      physicalResourceId: convId,
    });
    expect(read).toMatchObject({ name: 'Linked', actor_id: actorId });
  });

  test('create normalizes a camelCase actorId key', async () => {
    const convId = await applyCreateResource({
      resourceType: 'conversation',
      projectId: internalProjectId,
      resolvedProperties: { actorId },
    });

    const read = await readModule('conversation').read?.({
      physicalResourceId: convId,
    });
    expect(read).toMatchObject({ actor_id: actorId });
  });
});

// ── agent tool bindings ─────────────────────────────────────────────────────

describe('agentsFormationModule tool_bindings', () => {
  test('create with tool_bindings persists references and read returns them', async () => {
    const agentPhysId = await applyCreateResource({
      resourceType: 'agent',
      projectId: internalProjectId,
      resolvedProperties: {
        ai_provider_id: aiProviderId,
        name: 'FM Binding Agent',
        tool_bindings: [
          { tool_id: converterToolId },
          // A stray unknown key on a binding is ignored — formations read only
          // tool_id; guardrails attach via guardrail_ids, not the binding.
          { tool_id: converterToolId, bogus_field: true },
        ],
      },
    });

    const read = await readModule('agent').read?.({
      physicalResourceId: agentPhysId,
    });
    // Canonical view carries only the reference (any stray policy dropped).
    expect(read).toMatchObject({
      tool_bindings: [
        { tool_id: converterToolId },
        { tool_id: converterToolId },
      ],
    });
    expect(read).not.toHaveProperty('tool_ids');
  });

  // `tool_ids` was removed for v1. `formations.yaml` is the sole allowlist for
  // template properties, so dropping it there makes the field an unknown one.
  test('validateProperties rejects the removed tool_ids field', () => {
    const errors = readModule('agent').validateProperties?.({
      properties: {
        ai_provider_id: aiProviderId,
        tool_ids: [converterToolId],
      },
      basePath: 'resources.<agent>.properties',
    });
    expect(errors?.length).toBeGreaterThan(0);
    expect(
      errors?.some((e) => {
        return /unknown/i.test(e.message) && /tool_ids/.test(e.message);
      })
    ).toBe(true);
  });

  test('validateProperties rejects an inline tool binding', () => {
    const errors = readModule('agent').validateProperties?.({
      properties: {
        ai_provider_id: aiProviderId,
        tool_bindings: [{ tool: { name: 'inline', type: 'http' } }],
      },
      basePath: 'resources.<agent>.properties',
    });
    expect(errors?.length).toBeGreaterThan(0);
    expect(
      errors?.some((e) => {
        return /inline `tool` bindings are not supported/i.test(e.message);
      })
    ).toBe(true);
  });

  test('validateProperties rejects an unknown boundary_policy action', () => {
    const errors = readModule('agent').validateProperties?.({
      properties: {
        ai_provider_id: aiProviderId,
        boundary_policy: {
          statement: [{ effect: 'Deny', action: ['bogus:NotARealAction'] }],
        },
      },
      basePath: 'resources.<agent>.properties',
    });
    expect(errors?.length).toBeGreaterThan(0);
    expect(
      errors?.some((e) => {
        return e.path.endsWith('.boundary_policy');
      })
    ).toBe(true);
  });
});

// ── file storage fields are system-managed ─────────────────────────────────

describe('filesFormationModule', () => {
  test('rejects storage_type / storage_path as unknown fields', async () => {
    await expect(
      applyCreateResource({
        resourceType: 'file',
        projectId: internalProjectId,
        resolvedProperties: { storage_type: 'local', filename: 'file.txt' },
      })
    ).rejects.toThrow(/storage_type/);
  });

  // Unlike sessions, file deletion is idempotent: if the physical resource
  // was already removed out-of-band (drift), `deleteFile` resolves to `null`
  // instead of throwing, and the formation module ignores the return value.
  test('delete is idempotent when the file is already gone', async () => {
    await expect(
      applyDeleteResource({
        resourceType: 'file',
        physicalResourceId: 'fil_missing_zzz',
      })
    ).resolves.toBeUndefined();
  });
});

// ── policy document validation ──────────────────────────────────────────────

describe('policiesFormationModule', () => {
  test('create rejects an invalid policy document', async () => {
    await expect(
      applyCreateResource({
        resourceType: 'policy',
        projectId: internalProjectId,
        resolvedProperties: { document: { not: 'a valid document' } },
      })
    ).rejects.toThrow(/Policy document is invalid/);
  });

  test('update rejects an invalid policy document', async () => {
    const policyId = await applyCreateResource({
      resourceType: 'policy',
      projectId: internalProjectId,
      resolvedProperties: {
        name: 'Valid',
        document: {
          statement: [{ effect: 'Allow', action: ['tools:ListTools'] }],
        },
      },
    });

    await expect(
      applyUpdateResource({
        resourceType: 'policy',
        physicalResourceId: policyId,
        resolvedProperties: { document: { not: 'valid' } },
      })
    ).rejects.toThrow(/Policy document is invalid/);
  });

  test('rejects an unknown camelCase property key after normalization', async () => {
    await expect(
      applyCreateResource({
        resourceType: 'policy',
        projectId: internalProjectId,
        resolvedProperties: { document: {}, someUnknownKey: 'y' },
      })
    ).rejects.toThrow(/some_unknown_key/);
  });
});

// ── guardrail action-class document semantics ───────────────────────────────

describe('guardrailsFormationModule', () => {
  test('create rejects an invalid class literal', async () => {
    await expect(
      applyCreateResource({
        resourceType: 'guardrail',
        projectId: internalProjectId,
        resolvedProperties: { name: 'Bad Class', class: 'Z' },
      })
    ).rejects.toThrow(/class.*literal/i);
  });

  test('create rejects an escalate that is not a boolean', async () => {
    await expect(
      applyCreateResource({
        resourceType: 'guardrail',
        projectId: internalProjectId,
        resolvedProperties: {
          name: 'Bad Escalate',
          class: 'A',
          escalate: 'yes',
        },
      })
    ).rejects.toThrow(/escalate/i);
  });

  test('update rejects an invalid class literal', async () => {
    const guardrailId = await applyCreateResource({
      resourceType: 'guardrail',
      projectId: internalProjectId,
      resolvedProperties: { name: 'Valid Guardrail', class: 'A' },
    });

    await expect(
      applyUpdateResource({
        resourceType: 'guardrail',
        physicalResourceId: guardrailId,
        resolvedProperties: { class: 'Z' },
      })
    ).rejects.toThrow(/class.*literal/i);
  });

  test('rejects an unknown camelCase property key after normalization', async () => {
    await expect(
      applyCreateResource({
        resourceType: 'guardrail',
        projectId: internalProjectId,
        resolvedProperties: { name: 'X', class: 'A', someUnknownKey: 'y' },
      })
    ).rejects.toThrow(/some_unknown_key/);
  });
});

// ── secret write-only semantics ─────────────────────────────────────────────

describe('secretsFormationModule', () => {
  test('create requires a value', async () => {
    await expect(
      applyCreateResource({
        resourceType: 'secret',
        projectId: internalProjectId,
        resolvedProperties: { name: 'no_value' },
      })
    ).rejects.toThrow(/value/);
  });

  test('read is always null (secrets are write-only)', async () => {
    const secId = await applyCreateResource({
      resourceType: 'secret',
      projectId: internalProjectId,
      resolvedProperties: { name: 'wo_secret', value: 'v1' },
    });

    await expect(
      readModule('secret').read?.({ physicalResourceId: secId })
    ).resolves.toBeNull();
  });

  test('update changes the stored value without exposing it', async () => {
    const secId = await applyCreateResource({
      resourceType: 'secret',
      projectId: internalProjectId,
      resolvedProperties: { name: 'upd_secret', value: 'v1' },
    });

    await expect(
      applyUpdateResource({
        resourceType: 'secret',
        physicalResourceId: secId,
        resolvedProperties: { value: 'v2' },
      })
    ).resolves.toBeUndefined();
  });

  test('delete removes the secret', async () => {
    const secId = await applyCreateResource({
      resourceType: 'secret',
      projectId: internalProjectId,
      resolvedProperties: { name: 'del_secret', value: 'v1' },
    });

    await expect(
      applyDeleteResource({ resourceType: 'secret', physicalResourceId: secId })
    ).resolves.toBeUndefined();
  });

  test('sanitizeLastAppliedProperties strips the plaintext value', () => {
    const module = readModule('secret');
    expect(
      module.sanitizeLastAppliedProperties?.({ name: 'n', value: 'secret' })
    ).toEqual({ name: 'n' });
  });

  test('rejects an unknown camelCase property key after normalization', async () => {
    await expect(
      applyCreateResource({
        resourceType: 'secret',
        projectId: internalProjectId,
        resolvedProperties: { value: 'x', someUnknownKey: 'y' },
      })
    ).rejects.toThrow(/some_unknown_key/);
  });
});

// ── project price CRUD + drift-safe read ────────────────────────────────────

describe('projectPricesFormationModule', () => {
  const baseProps = {
    provider: 'openai',
    model: 'gpt-4o',
    component: 'output_tokens',
    unit: 'token',
    unit_price: 0.00001,
  };

  test('create requires unit_price', async () => {
    const { unit_price: _omit, ...withoutPrice } = baseProps;
    await expect(
      applyCreateResource({
        resourceType: 'project_price',
        projectId: internalProjectId,
        resolvedProperties: withoutPrice,
      })
    ).rejects.toThrow(/unit_price/);
  });

  test('create then read round-trips the priced fields', async () => {
    const priceId = await applyCreateResource({
      resourceType: 'project_price',
      projectId: internalProjectId,
      resolvedProperties: { ...baseProps, model: 'gpt-4o-read' },
    });
    expect(priceId).toMatch(/^price_/);

    const read = await readModule('project_price').read?.({
      physicalResourceId: priceId,
    });
    expect(read).toMatchObject({
      provider: 'openai',
      model: 'gpt-4o-read',
      component: 'output_tokens',
      unit: 'token',
      unit_price: 0.00001,
      meter_type: 'llm_tokens',
    });
    // effective_from defaults to deploy time so the price is live immediately.
    expect(typeof (read as { effective_from: string }).effective_from).toBe(
      'string'
    );
  });

  test('create scopes the row to the project (project + provider-slug tier)', async () => {
    const priceId = await applyCreateResource({
      resourceType: 'project_price',
      projectId: internalProjectId,
      resolvedProperties: { ...baseProps, model: 'gpt-4o-scope' },
    });

    const row = await db.PriceBook.findOne({ where: { publicId: priceId } });
    expect(row?.projectId).toBe(internalProjectId);
    expect(row?.aiProviderId).toBeNull();
  });

  test('update changes the unit_price in place on the same row', async () => {
    const priceId = await applyCreateResource({
      resourceType: 'project_price',
      projectId: internalProjectId,
      resolvedProperties: { ...baseProps, model: 'gpt-4o-upd' },
    });

    await applyUpdateResource({
      resourceType: 'project_price',
      physicalResourceId: priceId,
      resolvedProperties: {
        ...baseProps,
        model: 'gpt-4o-upd',
        unit_price: 0.5,
      },
    });

    const read = await readModule('project_price').read?.({
      physicalResourceId: priceId,
    });
    expect((read as { unit_price: number }).unit_price).toBe(0.5);

    // Same physical row — no new price version created by an in-place update.
    const count = await db.PriceBook.count({
      where: { projectId: internalProjectId, model: 'gpt-4o-upd' },
    });
    expect(count).toBe(1);
  });

  test('update omitting unit_price leaves the price untouched', async () => {
    const priceId = await applyCreateResource({
      resourceType: 'project_price',
      projectId: internalProjectId,
      resolvedProperties: { ...baseProps, model: 'gpt-4o-partial' },
    });

    // forUpdate skips the required-field check, so a partial update (here only
    // meter_type) is valid; unit_price is undefined and left as-is.
    await applyUpdateResource({
      resourceType: 'project_price',
      physicalResourceId: priceId,
      resolvedProperties: {
        provider: 'openai',
        model: 'gpt-4o-partial',
        component: 'output_tokens',
        unit: 'token',
        meter_type: 'llm_tokens',
      },
    });

    const read = await readModule('project_price').read?.({
      physicalResourceId: priceId,
    });
    expect((read as { unit_price: number }).unit_price).toBe(0.00001);
  });

  test('delete removes the price row', async () => {
    const priceId = await applyCreateResource({
      resourceType: 'project_price',
      projectId: internalProjectId,
      resolvedProperties: { ...baseProps, model: 'gpt-4o-del' },
    });

    await expect(
      applyDeleteResource({
        resourceType: 'project_price',
        physicalResourceId: priceId,
      })
    ).resolves.toBeUndefined();

    await expect(
      readModule('project_price').read?.({ physicalResourceId: priceId })
    ).resolves.toBeNull();
  });

  test('delete is a no-op for an already-absent row', async () => {
    await expect(
      applyDeleteResource({
        resourceType: 'project_price',
        physicalResourceId: 'price_does_not_exist',
      })
    ).resolves.toBeUndefined();
  });

  test('rejects an unknown camelCase property key after normalization', async () => {
    await expect(
      applyCreateResource({
        resourceType: 'project_price',
        projectId: internalProjectId,
        resolvedProperties: { ...baseProps, someUnknownKey: 'y' },
      })
    ).rejects.toThrow(/some_unknown_key/);
  });
});

// ── ai provider secret link + unknown-field normalization ───────────────────

describe('aiProvidersFormationModule', () => {
  test('create links a secret_id and read returns it', async () => {
    const providerId = await applyCreateResource({
      resourceType: 'ai_provider',
      projectId: internalProjectId,
      resolvedProperties: {
        name: 'Secret Provider',
        provider: 'openai',
        default_model: 'gpt-4o',
        secret_id: secretId,
      },
    });

    const read = await readModule('ai_provider').read?.({
      physicalResourceId: providerId,
    });
    expect(read).toMatchObject({ name: 'Secret Provider' });
    expect((read as { secret_id: string }).secret_id).toBe(secretId);
  });
});

// ── session lifecycle edge cases ────────────────────────────────────────────

describe('sessionsFormationModule', () => {
  test('update throws when the session is not found', async () => {
    await expect(
      applyUpdateResource({
        resourceType: 'session',
        physicalResourceId: 'sess_missing',
        resolvedProperties: {},
      })
    ).rejects.toThrow('Session not found: sess_missing');
  });

  test('delete throws when the session is not found', async () => {
    await expect(
      applyDeleteResource({
        resourceType: 'session',
        physicalResourceId: 'sess_missing',
      })
    ).rejects.toThrow('Session not found: sess_missing');
  });
});

// ── memory / document unknown camelCase keys ────────────────────────────────

describe('camelCase unknown-key normalization', () => {
  test.each([
    [
      'memory',
      () => {
        return { name: 'Mem', someUnknownKey: 'y' };
      },
    ],
    [
      'document',
      () => {
        return { content: 'hello', someUnknownKey: 'y' };
      },
    ],
  ] as Array<[string, () => Record<string, unknown>]>)(
    '%s rejects an unknown camelCase key after normalization',
    async (resourceType, properties) => {
      await expect(
        applyCreateResource({
          resourceType,
          projectId: internalProjectId,
          resolvedProperties: properties(),
        })
      ).rejects.toThrow(/some_unknown_key/);
    }
  );
});

// ── model_route resource type ──────────────────────────────────────────────

describe('modelRoutesFormationModule', () => {
  test('plans, applies, and reads back targets in snake_case', async () => {
    const routeId = await applyCreateResource({
      resourceType: 'model_route',
      projectId: internalProjectId,
      resolvedProperties: {
        name: 'formation-declared-route',
        targets: [
          { ai_provider_id: aiProviderId, model: 'gpt-4o' },
          {
            ai_provider_id: aiProviderId,
            model: 'gpt-4o-mini',
            max_retries: 1,
          },
        ],
        retry_on: ['provider_error', 'timeout'],
        failure_threshold: 2,
        cooldown_seconds: 30,
      },
    });
    expect(routeId).toMatch(/^route_/);

    expect(
      await readModule('model_route').read?.({ physicalResourceId: routeId })
    ).toEqual({
      name: 'formation-declared-route',
      targets: [
        { ai_provider_id: aiProviderId, model: 'gpt-4o' },
        { ai_provider_id: aiProviderId, model: 'gpt-4o-mini', max_retries: 1 },
      ],
      retry_on: ['provider_error', 'timeout'],
      failure_threshold: 2,
      cooldown_seconds: 30,
    });
  });

  test('updates a declared route in place', async () => {
    const routeId = await applyCreateResource({
      resourceType: 'model_route',
      projectId: internalProjectId,
      resolvedProperties: {
        name: 'formation-updated-route',
        targets: [{ ai_provider_id: aiProviderId, model: 'gpt-4o' }],
      },
    });

    await applyUpdateResource({
      resourceType: 'model_route',
      physicalResourceId: routeId,
      resolvedProperties: {
        name: 'formation-updated-route',
        targets: [{ ai_provider_id: aiProviderId, model: 'gpt-4o-mini' }],
        retry_on: ['rate_limited'],
      },
    });

    expect(
      await readModule('model_route').read?.({ physicalResourceId: routeId })
    ).toMatchObject({
      targets: [{ ai_provider_id: aiProviderId, model: 'gpt-4o-mini' }],
      retry_on: ['rate_limited'],
    });
  });

  test('rejects an unknown field', async () => {
    await expect(
      applyCreateResource({
        resourceType: 'model_route',
        projectId: internalProjectId,
        resolvedProperties: {
          name: 'formation-unknown-field-route',
          targets: [{ ai_provider_id: aiProviderId, model: 'gpt-4o' }],
          strategy: 'cheapest',
        },
      })
    ).rejects.toThrow(/strategy/);
  });

  test('requires a non-empty target list', async () => {
    await expect(
      applyCreateResource({
        resourceType: 'model_route',
        projectId: internalProjectId,
        resolvedProperties: { name: 'formation-empty-route', targets: [] },
      })
    ).rejects.toThrow(/targets must be a non-empty array/);
  });

  test('enforces the same attempt cap as the REST surface', async () => {
    await expect(
      applyCreateResource({
        resourceType: 'model_route',
        projectId: internalProjectId,
        resolvedProperties: {
          name: 'formation-capped-route',
          targets: [
            { ai_provider_id: aiProviderId, model: 'gpt-4o', max_retries: 9 },
            { ai_provider_id: aiProviderId, model: 'gpt-4o-mini' },
          ],
        },
      })
    ).rejects.toThrow(/the maximum is 10/);
  });

  test('rejects an unknown retry_on class', async () => {
    await expect(
      applyCreateResource({
        resourceType: 'model_route',
        projectId: internalProjectId,
        resolvedProperties: {
          name: 'formation-bad-retry-route',
          targets: [{ ai_provider_id: aiProviderId, model: 'gpt-4o' }],
          retry_on: ['gremlins'],
        },
      })
    ).rejects.toThrow(/unknown class 'gremlins'/);
  });

  test("rejects a target naming another project's provider", async () => {
    await expect(
      applyCreateResource({
        resourceType: 'model_route',
        projectId: internalProjectId,
        resolvedProperties: {
          name: 'formation-cross-project-route',
          targets: [{ ai_provider_id: 'aip_doesnotexist0', model: 'gpt-4o' }],
        },
      })
    ).rejects.toThrow(/not found in this project/);
  });

  test('rejects a non-positive failure_threshold', async () => {
    await expect(
      applyCreateResource({
        resourceType: 'model_route',
        projectId: internalProjectId,
        resolvedProperties: {
          name: 'formation-bad-breaker-route',
          targets: [{ ai_provider_id: aiProviderId, model: 'gpt-4o' }],
          failure_threshold: 0,
        },
      })
    ).rejects.toThrow(/failure_threshold must be a positive integer/);
  });

  // Declaring only one breaker value is valid — the lib defaults the other.
  test('accepts a declared cooldown_seconds without a failure_threshold', async () => {
    const routeId = await applyCreateResource({
      resourceType: 'model_route',
      projectId: internalProjectId,
      resolvedProperties: {
        name: 'formation-partial-breaker-route',
        targets: [{ ai_provider_id: aiProviderId, model: 'gpt-4o' }],
        cooldown_seconds: 15,
      },
    });

    expect(
      await readModule('model_route').read?.({ physicalResourceId: routeId })
    ).toMatchObject({ cooldown_seconds: 15, failure_threshold: 3 });
  });

  // Plan / validate runs `validateProperties` without touching the database, so
  // a bad template is rejected before anything is applied.
  test('validateProperties reports a missing target list at plan time', () => {
    const errors = readModule('model_route').validateProperties?.({
      properties: { name: 'formation-plan-time-route' },
      basePath: 'resources.<model_route>.properties',
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'resources.<model_route>.properties.targets',
          message: expect.stringMatching(/targets must be a non-empty array/),
        }),
      ])
    );
  });

  test('read returns null for a deleted route', async () => {
    const routeId = await applyCreateResource({
      resourceType: 'model_route',
      projectId: internalProjectId,
      resolvedProperties: {
        name: 'formation-deleted-route',
        targets: [{ ai_provider_id: aiProviderId, model: 'gpt-4o' }],
      },
    });

    await readModule('model_route').delete?.({ physicalResourceId: routeId });

    expect(
      await readModule('model_route').read?.({ physicalResourceId: routeId })
    ).toBeNull();
  });
});

// ── agent model binding (formations sync for model_route_id) ────────────────

describe('agentsFormationModule model binding', () => {
  const createRoute = async (name: string): Promise<string> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/model-routes')
      .send({
        project_id: projectId,
        name,
        targets: [{ ai_provider_id: aiProviderId, model: 'gpt-4o-mini' }],
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  test('round-trips model_route_id in snake_case', async () => {
    const routeId = await createRoute('formation-route-a');

    const agentId = await applyCreateResource({
      resourceType: 'agent',
      projectId: internalProjectId,
      resolvedProperties: {
        name: 'Routed Formation Agent',
        model_route_id: routeId,
      },
    });

    const read = await readModule('agent').read?.({
      physicalResourceId: agentId,
    });
    expect(read).toMatchObject({
      model_route_id: routeId,
      ai_provider_id: null,
    });
  });

  test('switches a pinned agent to a route when the pin is explicitly cleared', async () => {
    const routeId = await createRoute('formation-route-b');

    const agentId = await applyCreateResource({
      resourceType: 'agent',
      projectId: internalProjectId,
      resolvedProperties: {
        name: 'Switching Agent',
        ai_provider_id: aiProviderId,
      },
    });

    await applyUpdateResource({
      resourceType: 'agent',
      physicalResourceId: agentId,
      resolvedProperties: {
        name: 'Switching Agent',
        model_route_id: routeId,
        ai_provider_id: null,
      },
    });

    expect(
      await readModule('agent').read?.({ physicalResourceId: agentId })
    ).toMatchObject({ model_route_id: routeId, ai_provider_id: null });
  });

  test('rejects a template declaring both a provider and a route', async () => {
    const routeId = await createRoute('formation-route-c');

    await expect(
      applyCreateResource({
        resourceType: 'agent',
        projectId: internalProjectId,
        resolvedProperties: {
          name: 'Both Agent',
          ai_provider_id: aiProviderId,
          model_route_id: routeId,
        },
      })
    ).rejects.toThrow(/mutually exclusive/);
  });

  test('rejects a template declaring neither when the project has no default', async () => {
    await expect(
      applyCreateResource({
        resourceType: 'agent',
        projectId: internalProjectId,
        resolvedProperties: { name: 'Unbound Agent' },
      })
    ).rejects.toThrow(/binds neither ai_provider_id nor model_route_id/);
  });

  test('rejects combining model with a route', async () => {
    const routeId = await createRoute('formation-route-d');

    await expect(
      applyCreateResource({
        resourceType: 'agent',
        projectId: internalProjectId,
        resolvedProperties: {
          name: 'Route And Model Agent',
          model_route_id: routeId,
          model: 'gpt-4o-mini',
        },
      })
    ).rejects.toThrow(/each route target names its own model/);
  });
});

// ── ingestion rule converter rules ──────────────────────────────────────────

describe('ingestionRulesFormationModule', () => {
  test('create with a tool_id converter resolves the tool and read returns it', async () => {
    const ruleId = await applyCreateResource({
      resourceType: 'ingestion_rule',
      projectId: internalProjectId,
      resolvedProperties: {
        content_type_glob: 'image/*',
        tool_id: converterToolId,
        action: 'list-tools',
        native_extraction: 'skip',
        file_delivery: 'download_url',
      },
    });

    const read = await readModule('ingestion_rule').read?.({
      physicalResourceId: ruleId,
    });
    expect(read).toMatchObject({
      content_type_glob: 'image/*',
      tool_id: converterToolId,
      native_extraction: 'skip',
      file_delivery: 'download_url',
    });
  });

  test('rejects when both tool_id and agent_id are set', async () => {
    await expect(
      applyCreateResource({
        resourceType: 'ingestion_rule',
        projectId: internalProjectId,
        resolvedProperties: {
          content_type_glob: 'image/*',
          tool_id: converterToolId,
          agent_id: agentId,
        },
      })
    ).rejects.toThrow('tool_id and agent_id are mutually exclusive');
  });

  test('rejects when neither tool_id nor agent_id is set', async () => {
    await expect(
      applyCreateResource({
        resourceType: 'ingestion_rule',
        projectId: internalProjectId,
        resolvedProperties: { content_type_glob: 'image/*' },
      })
    ).rejects.toThrow('exactly one of tool_id or agent_id is required');
  });

  test('rejects an unknown field', async () => {
    await expect(
      applyCreateResource({
        resourceType: 'ingestion_rule',
        projectId: internalProjectId,
        resolvedProperties: {
          content_type_glob: 'image/*',
          agent_id: agentId,
          bogus_field: 'nope',
        },
      })
    ).rejects.toThrow("Unknown ingestion rule field 'bogus_field'");
  });

  test('update rejects setting both tool_id and agent_id', async () => {
    const ruleId = await applyCreateResource({
      resourceType: 'ingestion_rule',
      projectId: internalProjectId,
      resolvedProperties: { content_type_glob: 'text/*', agent_id: agentId },
    });

    await expect(
      applyUpdateResource({
        resourceType: 'ingestion_rule',
        physicalResourceId: ruleId,
        resolvedProperties: { tool_id: converterToolId, agent_id: agentId },
      })
    ).rejects.toThrow('tool_id and agent_id are mutually exclusive');
  });

  test('update can switch the converter from tool to agent (clearing tool_id)', async () => {
    const ruleId = await applyCreateResource({
      resourceType: 'ingestion_rule',
      projectId: internalProjectId,
      resolvedProperties: {
        content_type_glob: 'video/*',
        tool_id: converterToolId,
        action: 'list-tools',
      },
    });

    await applyUpdateResource({
      resourceType: 'ingestion_rule',
      physicalResourceId: ruleId,
      resolvedProperties: { agent_id: agentId, tool_id: null },
    });

    const read = await readModule('ingestion_rule').read?.({
      physicalResourceId: ruleId,
    });
    expect(read).toMatchObject({ agent_id: agentId, tool_id: null });
  });
});

// ── webhook getAttributes ───────────────────────────────────────────────────

describe('webhooksFormationModule', () => {
  test('getAttributes returns the generated signing secret', async () => {
    const webhookId = await applyCreateResource({
      resourceType: 'webhook',
      projectId: internalProjectId,
      resolvedProperties: {
        name: 'Signed Hook',
        url: 'https://example.com/signed',
        events: ['conversation.created'],
      },
    });

    const attrs = await readModule('webhook').getAttributes?.({
      physicalResourceId: webhookId,
    });
    expect(typeof attrs?.secret).toBe('string');
    expect(attrs?.secret.length).toBeGreaterThan(0);
  });

  test('validateProperties normalizes camelCase keys before field validation', () => {
    // A camelCase key (e.g. `webhookUrl`, as the caseTransform middleware stores
    // it) is normalized to snake_case (`webhook_url`) before the unknown-field
    // check runs, so it is reported as an unknown field.
    const errors = readModule('webhook').validateProperties?.({
      properties: {
        webhookUrl: 'http://example.com',
        events: ['*'],
        name: 't',
      },
      basePath: 'resources.MyWebhook.properties',
    });
    expect(
      errors?.some((error) => {
        return error.message.includes('webhook_url');
      })
    ).toBe(true);
  });
});

// ── orchestration node/edge key conversion ──────────────────────────────────

describe('orchestrationsFormationModule', () => {
  const orchestrationProperties = () => {
    return {
      name: 'Content Squad',
      description: 'writer then reviewer',
      nodes: [
        {
          id: 'write',
          type: 'agent',
          agent_id: agentId,
          input_mapping: { prompt: { var: 'input.topic' } },
          state_mapping: { 'state.draft': { var: 'output.content' } },
        },
        {
          id: 'review',
          type: 'agent',
          agent_id: agentId,
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
  };

  test('create converts snake_case node/edge keys and read converts them back', async () => {
    const orchId = await applyCreateResource({
      resourceType: 'orchestration',
      projectId: internalProjectId,
      resolvedProperties: orchestrationProperties(),
    });

    const read = await readModule('orchestration').read?.({
      physicalResourceId: orchId,
    });
    expect(read).toMatchObject({
      name: 'Content Squad',
      description: 'writer then reviewer',
      nodes: [
        {
          id: 'write',
          type: 'agent',
          agent_id: agentId,
          input_mapping: { prompt: { var: 'input.topic' } },
          state_mapping: { 'state.draft': { var: 'output.content' } },
        },
        {
          id: 'review',
          type: 'agent',
          agent_id: agentId,
          input_mapping: { prompt: { var: 'draft' } },
          state_mapping: { 'state.review': { var: 'output.content' } },
        },
      ],
      edges: [{ from: 'write', to: 'review', activation_condition: 'all' }],
      input_schema: {
        type: 'object',
        properties: { topic: { type: 'string' } },
      },
    });
  });

  test('create normalizes a camelCase top-level key (stateSchema)', async () => {
    const orchId = await applyCreateResource({
      resourceType: 'orchestration',
      projectId: internalProjectId,
      resolvedProperties: {
        name: 'Camel Squad',
        nodes: [{ id: 'a', type: 'transform', expression: 1 }],
        edges: [],
        stateSchema: { type: 'object' },
      },
    });

    const read = await readModule('orchestration').read?.({
      physicalResourceId: orchId,
    });
    expect(read).toMatchObject({ state_schema: { type: 'object' } });
  });

  test('update applies only the provided fields', async () => {
    const orchId = await applyCreateResource({
      resourceType: 'orchestration',
      projectId: internalProjectId,
      resolvedProperties: orchestrationProperties(),
    });

    await applyUpdateResource({
      resourceType: 'orchestration',
      physicalResourceId: orchId,
      resolvedProperties: { name: 'Renamed Squad' },
    });

    const read = await readModule('orchestration').read?.({
      physicalResourceId: orchId,
    });
    expect(read).toMatchObject({
      name: 'Renamed Squad',
      description: 'writer then reviewer',
    });
  });

  test('update replaces nodes and edges, converting their keys to camelCase', async () => {
    const orchId = await applyCreateResource({
      resourceType: 'orchestration',
      projectId: internalProjectId,
      resolvedProperties: orchestrationProperties(),
    });

    await applyUpdateResource({
      resourceType: 'orchestration',
      physicalResourceId: orchId,
      resolvedProperties: {
        name: 'Rewired Squad',
        nodes: [{ id: 'only', type: 'agent', agent_id: agentId }],
        edges: [],
      },
    });

    const read = await readModule('orchestration').read?.({
      physicalResourceId: orchId,
    });
    expect(read).toMatchObject({
      name: 'Rewired Squad',
      nodes: [{ id: 'only', type: 'agent', agent_id: agentId }],
      edges: [],
    });
  });

  test('rejects an unknown field', async () => {
    await expect(
      applyCreateResource({
        resourceType: 'orchestration',
        projectId: internalProjectId,
        resolvedProperties: {
          name: 'X',
          nodes: [],
          edges: [],
          bogus_field: true,
        },
      })
    ).rejects.toThrow(/bogus_field/);
  });

  test('requires nodes', async () => {
    await expect(
      applyCreateResource({
        resourceType: 'orchestration',
        projectId: internalProjectId,
        resolvedProperties: { name: 'X' },
      })
    ).rejects.toThrow(/`nodes` is required/);
  });
});

// The three types are one lifecycle. Each item is its own resource, so an item
// curated through the API is never collateral of a formation apply.

describe('evaluations formation modules', () => {
  test('dataset → dataset_item → eval create/read/update/delete lifecycle', async () => {
    const datasetId = await applyCreateResource({
      resourceType: 'dataset',
      projectId: internalProjectId,
      resolvedProperties: {
        name: 'Formation Suite',
        description: 'billing questions',
      },
    });
    expect(datasetId).toMatch(/^dset_/);
    expect(
      await readModule('dataset').read?.({ physicalResourceId: datasetId })
    ).toMatchObject({
      name: 'Formation Suite',
      description: 'billing questions',
    });

    const itemId = await applyCreateResource({
      resourceType: 'dataset_item',
      projectId: internalProjectId,
      resolvedProperties: {
        dataset_id: datasetId,
        input: [{ role: 'user', content: 'capital of France?' }],
        expected_output: 'Paris',
        metadata: { topic: 'geography' },
      },
    });
    expect(itemId).toMatch(/^dsit_/);
    expect(
      await readModule('dataset_item').read?.({ physicalResourceId: itemId })
    ).toMatchObject({
      dataset_id: datasetId,
      input: [{ role: 'user', content: 'capital of France?' }],
      expected_output: 'Paris',
      metadata: { topic: 'geography' },
    });

    const evalId = await applyCreateResource({
      resourceType: 'eval',
      projectId: internalProjectId,
      resolvedProperties: {
        name: 'Formation Eval',
        agent_id: agentId,
        dataset_id: datasetId,
        scorers: [{ type: 'exact_match' }],
        pass_threshold: 0.8,
      },
    });
    expect(evalId).toMatch(/^eval_/);
    expect(
      await readModule('eval').read?.({ physicalResourceId: evalId })
    ).toMatchObject({
      name: 'Formation Eval',
      agent_id: agentId,
      dataset_id: datasetId,
      scorers: [{ type: 'exact_match' }],
      pass_threshold: 0.8,
    });

    // The PRD's round-trip criterion: changing `pass_threshold` updates the
    // eval in place rather than replacing it.
    await applyUpdateResource({
      resourceType: 'eval',
      physicalResourceId: evalId,
      resolvedProperties: {
        name: 'Formation Eval',
        agent_id: agentId,
        dataset_id: datasetId,
        scorers: [{ type: 'contains', value: 'Paris' }],
        pass_threshold: 0.5,
      },
    });
    expect(
      await readModule('eval').read?.({ physicalResourceId: evalId })
    ).toMatchObject({
      pass_threshold: 0.5,
      scorers: [{ type: 'contains', value: 'Paris' }],
    });

    await applyUpdateResource({
      resourceType: 'dataset_item',
      physicalResourceId: itemId,
      resolvedProperties: {
        dataset_id: datasetId,
        input: [{ role: 'user', content: 'capital of Italy?' }],
        expected_output: 'Rome',
      },
    });
    expect(
      await readModule('dataset_item').read?.({ physicalResourceId: itemId })
    ).toMatchObject({
      input: [{ role: 'user', content: 'capital of Italy?' }],
      expected_output: 'Rome',
    });

    await applyUpdateResource({
      resourceType: 'dataset',
      physicalResourceId: datasetId,
      resolvedProperties: { name: 'Formation Suite v2', description: null },
    });
    expect(
      await readModule('dataset').read?.({ physicalResourceId: datasetId })
    ).toMatchObject({ name: 'Formation Suite v2', description: null });

    await applyDeleteResource({
      resourceType: 'eval',
      physicalResourceId: evalId,
    });
    expect(
      await readModule('eval').read?.({ physicalResourceId: evalId })
    ).toBeNull();

    await applyDeleteResource({
      resourceType: 'dataset_item',
      physicalResourceId: itemId,
    });
    expect(
      await readModule('dataset_item').read?.({ physicalResourceId: itemId })
    ).toBeNull();

    await applyDeleteResource({
      resourceType: 'dataset',
      physicalResourceId: datasetId,
    });
    expect(
      await readModule('dataset').read?.({ physicalResourceId: datasetId })
    ).toBeNull();
  });

  test('an eval rejects an unknown field and a missing required field', async () => {
    await expect(
      applyCreateResource({
        resourceType: 'eval',
        projectId: internalProjectId,
        resolvedProperties: {
          name: 'Bad Eval',
          agent_id: agentId,
          dataset_id: 'dset_whatever',
          scorers: [],
          bogus_field: true,
        },
      })
    ).rejects.toThrow(/bogus_field/);

    await expect(
      applyCreateResource({
        resourceType: 'eval',
        projectId: internalProjectId,
        resolvedProperties: { name: 'Incomplete Eval', agent_id: agentId },
      })
    ).rejects.toThrow(/`dataset_id` is required/);
  });

  test('a dataset_item requires its parent dataset', async () => {
    await expect(
      applyCreateResource({
        resourceType: 'dataset_item',
        projectId: internalProjectId,
        resolvedProperties: {
          input: [{ role: 'user', content: 'orphan' }],
        },
      })
    ).rejects.toThrow(/`dataset_id` is required/);
  });

  // A template update is a patch: a field the template does not mention is left
  // alone rather than cleared. Without this, restating only `input` on an item
  // would silently drop the reference answer scorers compare against.
  test('an omitted nullable field is left alone, not cleared', async () => {
    const datasetId = await applyCreateResource({
      resourceType: 'dataset',
      projectId: internalProjectId,
      resolvedProperties: {
        name: 'Declared-Only Suite',
        description: 'keep me',
      },
    });
    const itemId = await applyCreateResource({
      resourceType: 'dataset_item',
      projectId: internalProjectId,
      resolvedProperties: {
        dataset_id: datasetId,
        input: [{ role: 'user', content: 'first' }],
        expected_output: 'Paris',
        metadata: { topic: 'geography' },
      },
    });
    const evalId = await applyCreateResource({
      resourceType: 'eval',
      projectId: internalProjectId,
      resolvedProperties: {
        name: 'Declared-Only Eval',
        agent_id: agentId,
        dataset_id: datasetId,
        scorers: [{ type: 'exact_match' }],
        pass_threshold: 0.9,
      },
    });

    await applyUpdateResource({
      resourceType: 'dataset',
      physicalResourceId: datasetId,
      resolvedProperties: { name: 'Declared-Only Suite v2' },
    });
    expect(
      await readModule('dataset').read?.({ physicalResourceId: datasetId })
    ).toMatchObject({ name: 'Declared-Only Suite v2', description: 'keep me' });

    await applyUpdateResource({
      resourceType: 'dataset_item',
      physicalResourceId: itemId,
      resolvedProperties: {
        dataset_id: datasetId,
        input: [{ role: 'user', content: 'second' }],
      },
    });
    expect(
      await readModule('dataset_item').read?.({ physicalResourceId: itemId })
    ).toMatchObject({
      input: [{ role: 'user', content: 'second' }],
      expected_output: 'Paris',
      metadata: { topic: 'geography' },
    });

    await applyUpdateResource({
      resourceType: 'eval',
      physicalResourceId: evalId,
      resolvedProperties: {
        name: 'Declared-Only Eval v2',
        agent_id: agentId,
        dataset_id: datasetId,
        scorers: [{ type: 'exact_match' }],
      },
    });
    expect(
      await readModule('eval').read?.({ physicalResourceId: evalId })
    ).toMatchObject({ name: 'Declared-Only Eval v2', pass_threshold: 0.9 });

    // An explicit null does clear a declared field — the other half of the pair.
    await applyUpdateResource({
      resourceType: 'dataset_item',
      physicalResourceId: itemId,
      resolvedProperties: {
        dataset_id: datasetId,
        input: [{ role: 'user', content: 'second' }],
        metadata: null,
      },
    });
    expect(
      await readModule('dataset_item').read?.({ physicalResourceId: itemId })
    ).toMatchObject({ metadata: null, expected_output: 'Paris' });

    await applyUpdateResource({
      resourceType: 'eval',
      physicalResourceId: evalId,
      resolvedProperties: {
        name: 'Declared-Only Eval v2',
        agent_id: agentId,
        dataset_id: datasetId,
        scorers: [{ type: 'exact_match' }],
        pass_threshold: null,
      },
    });
    expect(
      await readModule('eval').read?.({ physicalResourceId: evalId })
    ).toMatchObject({ pass_threshold: null });

    await applyDeleteResource({
      resourceType: 'dataset',
      physicalResourceId: datasetId,
    });
  });

  test('moving a dataset_item to another dataset is rejected', async () => {
    const datasetId = await applyCreateResource({
      resourceType: 'dataset',
      projectId: internalProjectId,
      resolvedProperties: { name: 'Immutable Parent Suite' },
    });
    const otherDatasetId = await applyCreateResource({
      resourceType: 'dataset',
      projectId: internalProjectId,
      resolvedProperties: { name: 'Immutable Other Suite' },
    });
    const itemId = await applyCreateResource({
      resourceType: 'dataset_item',
      projectId: internalProjectId,
      resolvedProperties: {
        dataset_id: datasetId,
        input: [{ role: 'user', content: 'stays put' }],
      },
    });

    // Silently applying the rest would report success for an apply that left
    // the item in the dataset the template no longer names.
    await expect(
      applyUpdateResource({
        resourceType: 'dataset_item',
        physicalResourceId: itemId,
        resolvedProperties: {
          dataset_id: otherDatasetId,
          input: [{ role: 'user', content: 'moved' }],
        },
      })
    ).rejects.toThrow(/dataset_id is immutable/);
    expect(
      await readModule('dataset_item').read?.({ physicalResourceId: itemId })
    ).toMatchObject({
      dataset_id: datasetId,
      input: [{ role: 'user', content: 'stays put' }],
    });

    // Deleting the parent cascades to the item, so tearing the stack down must
    // still work when the item resource is deleted after its dataset.
    await applyDeleteResource({
      resourceType: 'dataset',
      physicalResourceId: datasetId,
    });
    await applyDeleteResource({
      resourceType: 'dataset_item',
      physicalResourceId: itemId,
    });
    await expect(
      applyUpdateResource({
        resourceType: 'dataset_item',
        physicalResourceId: itemId,
        resolvedProperties: {
          dataset_id: datasetId,
          input: [{ role: 'user', content: 'gone' }],
        },
      })
    ).rejects.toThrow(/not found/);
    await applyDeleteResource({
      resourceType: 'dataset',
      physicalResourceId: otherDatasetId,
    });
  });

  test('read returns null for resources that no longer exist', async () => {
    expect(
      await readModule('dataset').read?.({ physicalResourceId: 'dset_missing' })
    ).toBeNull();
    expect(
      await readModule('dataset_item').read?.({
        physicalResourceId: 'dsit_missing',
      })
    ).toBeNull();
    expect(
      await readModule('eval').read?.({ physicalResourceId: 'eval_missing' })
    ).toBeNull();
  });
});
