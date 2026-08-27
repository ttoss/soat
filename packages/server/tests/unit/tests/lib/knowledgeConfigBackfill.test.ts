import { db } from 'src/db';
import { readKnowledgeConfig } from 'src/lib/agentKnowledge';
import {
  backfillKnowledgeConfigCasing,
  toWireKnowledgeConfig,
} from 'src/lib/knowledgeConfigBackfill';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * The bag exactly as request middleware used to store it, before single-casing:
 * every key camelCased, including inside `extraction`.
 */
const PRE_SINGLE_CASING_CONFIG = {
  memoryIds: ['mem_seed'],
  memoryTags: ['tag1'],
  documentIds: ['doc_1'],
  documentPaths: ['/docs/'],
  minScore: 0.4,
  limit: 7,
  writeMemoryId: 'mem_write',
  extraction: {
    enabled: true,
    aiProviderId: 'aip_1',
    model: 'llama3.2:1b',
    prompt: 'extract facts',
  },
};

const WIRE_CONFIG = {
  memory_ids: ['mem_seed'],
  memory_tags: ['tag1'],
  document_ids: ['doc_1'],
  document_paths: ['/docs/'],
  min_score: 0.4,
  limit: 7,
  write_memory_id: 'mem_write',
  extraction: {
    enabled: true,
    ai_provider_id: 'aip_1',
    model: 'llama3.2:1b',
    prompt: 'extract facts',
  },
};

describe('toWireKnowledgeConfig', () => {
  test('rewrites every pre-single-casing key to the wire spelling', () => {
    expect(toWireKnowledgeConfig(PRE_SINGLE_CASING_CONFIG)).toEqual(
      WIRE_CONFIG
    );
  });

  test('returns null for a bag that is already wire-shaped', () => {
    expect(toWireKnowledgeConfig(WIRE_CONFIG)).toBeNull();
  });

  test('returns null for a non-object value', () => {
    expect(toWireKnowledgeConfig(null)).toBeNull();
    expect(toWireKnowledgeConfig('nope')).toBeNull();
  });

  test('keeps the wire value when a bag somehow carries both spellings', () => {
    expect(
      toWireKnowledgeConfig({ writeMemoryId: 'old', write_memory_id: 'new' })
    ).toEqual({ write_memory_id: 'new' });
  });

  test('leaves keys it does not own alone', () => {
    // `extraction.prompt` is free text and `limit` is already snake-neutral;
    // neither is a rename target, and nothing walks into arbitrary values.
    expect(
      toWireKnowledgeConfig({
        minScore: 0.1,
        extraction: { prompt: 'keep camelCase words like writeMemoryId here' },
      })
    ).toEqual({
      min_score: 0.1,
      extraction: { prompt: 'keep camelCase words like writeMemoryId here' },
    });
  });
});

describe('backfillKnowledgeConfigCasing', () => {
  let adminToken: string;
  let projectId: string;
  let aiProviderId: string;
  let agentId: string;

  beforeAll(async () => {
    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'admin', password: 'supersecret' });
    adminToken = await loginAs('admin', 'supersecret');

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Knowledge Config Backfill Project' });
    projectId = projectRes.body.id;

    const providerRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Backfill Provider',
        provider: 'openai',
        default_model: 'gpt-4o',
      });
    aiProviderId = providerRes.body.id;

    const agentRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        ai_provider_id: aiProviderId,
        name: 'Backfill Agent',
      });
    agentId = agentRes.body.id;
  });

  const seedPreSingleCasingAgent = async () => {
    const agent = await db.Agent.findOne({ where: { publicId: agentId } });
    agent!.knowledgeConfig = { ...PRE_SINGLE_CASING_CONFIG };
    await agent!.save();
  };

  const reloadAgentConfig = async (): Promise<unknown> => {
    const agent = await db.Agent.findOne({ where: { publicId: agentId } });
    return agent!.knowledgeConfig;
  };

  test('a pre-single-casing agent resolves its knowledge fields only after the backfill', async () => {
    await seedPreSingleCasingAgent();

    // The read path maps casing field by field, so a key whose spellings differ
    // resolves to nothing and its feature is silently off. `limit` and the
    // `extraction.*` keys are casing-neutral and prove nothing.
    const stale = readKnowledgeConfig(await reloadAgentConfig());
    expect(stale?.writeMemoryId).toBeUndefined();
    expect(stale?.memoryIds).toBeUndefined();
    expect(stale?.extraction).toEqual({
      enabled: true,
      model: 'llama3.2:1b',
      prompt: 'extract facts',
    });

    await backfillKnowledgeConfigCasing();

    const migrated = readKnowledgeConfig(await reloadAgentConfig());
    expect(migrated?.writeMemoryId).toBe('mem_write');
    expect(migrated?.memoryIds).toEqual(['mem_seed']);
    expect(migrated?.extraction).toEqual({
      enabled: true,
      aiProviderId: 'aip_1',
      model: 'llama3.2:1b',
      prompt: 'extract facts',
    });
  });

  test('the migrated agent reads back over REST in the wire casing', async () => {
    await seedPreSingleCasingAgent();
    await backfillKnowledgeConfigCasing();

    const res = await authenticatedTestClient(adminToken).get(
      `/api/v1/agents/${agentId}`
    );
    expect(res.status).toBe(200);
    expect(res.body.knowledge_config).toEqual(WIRE_CONFIG);
  });

  test('is idempotent — a second run rewrites nothing', async () => {
    await seedPreSingleCasingAgent();

    const first = await backfillKnowledgeConfigCasing();
    expect(first.agents).toBeGreaterThanOrEqual(1);

    const second = await backfillKnowledgeConfigCasing();
    expect(second.agents).toBe(0);
    expect(await reloadAgentConfig()).toEqual(WIRE_CONFIG);
  });

  test('migrates the config archived on a version snapshot too', async () => {
    // Every agent write archives a version, so the snapshot the agent above
    // produced is the row under test; seed it the way a pre-single-casing
    // write would have left it.
    const agent = await db.Agent.findOne({ where: { publicId: agentId } });
    const version = await db.AgentVersion.findOne({
      where: { agentId: agent!.id as number },
      order: [['version', 'DESC']],
    });
    expect(version).not.toBeNull();

    const config = version!.config as Record<string, unknown>;
    version!.config = {
      ...config,
      knowledge_config: { ...PRE_SINGLE_CASING_CONFIG },
    };
    await version!.save();

    const result = await backfillKnowledgeConfigCasing();
    expect(result.agentVersions).toBeGreaterThanOrEqual(1);

    const reloaded = await db.AgentVersion.findOne({
      where: { id: version!.id as number },
    });
    const reloadedConfig = reloaded!.config as Record<string, unknown>;
    expect(reloadedConfig.knowledge_config).toEqual(WIRE_CONFIG);
    // Sibling config fields are untouched — only the one key is rewritten.
    expect(reloadedConfig.name).toBe(config.name);
  });
});
