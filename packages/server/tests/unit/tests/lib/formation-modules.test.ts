import { db } from 'src/db';
import { getFormationModule } from 'src/lib/formationsRegistry';
import {
  applyCreateResource,
  applyDeleteResource,
  applyUpdateResource,
} from 'src/lib/formationsResourceHandlers';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

// ── About this file ─────────────────────────────────────────────────────────
//
// Formation modules are thin adapters that map a formation resource's
// snake_case `properties` onto the module's lib CRUD functions. This suite
// exercises them through the real `applyCreate/Update/DeleteResource` entry
// points against the real Postgres testcontainer — no internal `spyOn` and no
// `as any`/`as unknown` casts (per `.claude/rules/tests.md` "Never Mock What
// You Own"). Every create/update/delete is verified by reading the resource
// back through the module's own `read`, so a broken adapter (wrong field name,
// missing normalization) fails the assertion rather than silently passing
// against a mock.
//
// Shared referenced resources (project, ai provider, agent, tool, memory,
// policy, actor, secret) are created once via the REST API as the bootstrap
// admin; formation modules resolve public → internal ids themselves.

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
    type: 'soat',
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
  ['secret', 'Secret `properties` must be an object'],
  ['session', 'Session `properties` must be an object'],
  ['ingestion_rule', 'Ingestion rule `properties` must be an object'],
  ['agent', 'Agent `properties` must be an object'],
  ['memory', 'Memory `properties` must be an object'],
  ['orchestration', 'Orchestration `properties` must be an object'],
  ['ai_provider', 'AI provider `properties` must be an object'],
  ['actor', 'Actor `properties` must be an object'],
  ['discussion', 'Discussion `properties` must be an object'],
  ['tool', 'Tool `properties` must be an object'],
  ['document', 'Document `properties` must be an object'],
];

// `document` update is a no-op and performs no validation; every other module
// validates on update too.
const UPDATE_NON_OBJECT = NON_OBJECT.filter(([resourceType]) => {
  return resourceType !== 'document';
});

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

// ── Create → read round-trips (consolidated) ────────────────────────────────
//
// Each case creates a resource through the real adapter and reads it back
// through the same adapter, asserting the snake_case round-trip. Property
// factories are functions so the shared fixture ids (set in `beforeAll`) are
// read at test time, not at table-construction time.

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
      return {
        create: { content: 'hello world', title: 'Doc A' },
        expectRead: { content: 'hello world', title: 'Doc A' },
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
    resourceType: 'discussion',
    build: (seed) => {
      return {
        create: { name: `Disc ${seed}`, ai_provider_id: aiProviderId },
        expectRead: { name: `Disc ${seed}`, ai_provider_id: aiProviderId },
        // Discussion validation enforces required fields on update too, so the
        // update payload must carry `name` and `ai_provider_id`.
        update: { name: `Disc ${seed} updated`, ai_provider_id: aiProviderId },
        expectAfterUpdate: { name: `Disc ${seed} updated` },
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

// ── chat / document immutable-update no-ops ─────────────────────────────────

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

  test('document update is a no-op and never touches the resource', async () => {
    await expect(
      applyUpdateResource({
        resourceType: 'document',
        physicalResourceId: 'doc_anything',
        resolvedProperties: {},
      })
    ).resolves.toBeUndefined();
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
          input_mapping: { prompt: { var: 'topic' } },
          output_mapping: { content: 'state.draft' },
        },
        {
          id: 'review',
          type: 'agent',
          agent_id: agentId,
          input_mapping: { prompt: { var: 'draft' } },
          output_mapping: { content: 'state.review' },
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
          input_mapping: { prompt: { var: 'topic' } },
          output_mapping: { content: 'state.draft' },
        },
        {
          id: 'review',
          type: 'agent',
          agent_id: agentId,
          input_mapping: { prompt: { var: 'draft' } },
          output_mapping: { content: 'state.review' },
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
