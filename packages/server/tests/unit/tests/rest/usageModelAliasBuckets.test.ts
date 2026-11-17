import { db } from 'src/db';
import { recordCompletionUsage } from 'src/lib/usageRecording';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

type Bucket = {
  key: string | null;
  ai_provider_id: string | null;
  event_count: number;
};

const USAGE = {
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
  inputTokenDetails: {
    noCacheTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  outputTokenDetails: { textTokens: 5, reasoningTokens: 0 },
};

/**
 * An event recorded under the vendor id a provider later aliases buckets with
 * the events recorded under the alias: one model, one bucket.
 */
describe('usage by model under a provider alias', () => {
  let adminToken: string;
  let projectId: string;
  let internalProjectId: number;
  let aliasedId: string;
  let plainId: string;
  let ambiguousId: string;
  let counter = 0;

  const createProvider = async (extra: Record<string, unknown>) => {
    counter += 1;
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: `alias-buckets-${Date.now()}-${counter}`,
        provider: 'ollama',
        base_url: 'http://127.0.0.1:9',
        default_model: 'vendor-fast-2026',
        ...extra,
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const record = async (args: { providerId: string; model: string }) => {
    const provider = await db.AiProvider.findOne({
      where: { publicId: args.providerId },
    });
    await recordCompletionUsage({
      source: 'chat',
      projectId: internalProjectId,
      provider: 'ollama',
      aiProviderId: provider!.id,
      model: args.model,
      usage: USAGE,
    });
  };

  const aggregate = async (query: string) => {
    const res = await authenticatedTestClient(adminToken).get(
      `/api/v1/usage/aggregate?project_id=${projectId}&${query}`
    );
    expect(res.status).toBe(200);
    return res.body;
  };

  const bucketsOf = (groups: Bucket[], providerId: string) => {
    return groups
      .filter((group) => {
        return group.ai_provider_id === providerId;
      })
      .map((group) => {
        return [group.key, group.event_count];
      });
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'aliasbuckets',
      policyActions: [],
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;
    const project = await db.Project.findOne({
      where: { publicId: projectId },
    });
    internalProjectId = project!.id;

    aliasedId = await createProvider({});
    plainId = await createProvider({});
    ambiguousId = await createProvider({
      model_aliases: { a: 'vendor-shared', b: 'vendor-shared' },
    });

    // Recorded before the provider aliases the vendor id.
    await record({ providerId: aliasedId, model: 'vendor-fast-2026' });
    await record({ providerId: plainId, model: 'vendor-fast-2026' });
    await record({ providerId: ambiguousId, model: 'vendor-shared' });

    const aliased = await authenticatedTestClient(adminToken)
      .patch(`/api/v1/ai-providers/${aliasedId}`)
      .send({ model_aliases: { fast: 'vendor-fast-2026' } });
    expect(aliased.status).toBe(200);

    await record({ providerId: aliasedId, model: 'fast' });
    await record({ providerId: aliasedId, model: 'fast' });
  });

  test('a pre-alias and a post-alias event land in one bucket', async () => {
    const body = await aggregate('group_by=model');
    expect(bucketsOf(body.groups.data, aliasedId)).toEqual([['fast', 3]]);
  });

  test('a provider that aliases nothing keeps the recorded id', async () => {
    const body = await aggregate('group_by=model');
    expect(bucketsOf(body.groups.data, plainId)).toEqual([
      ['vendor-fast-2026', 1],
    ]);
  });

  test('a vendor id two aliases share keeps the recorded id', async () => {
    const body = await aggregate('group_by=model');
    expect(bucketsOf(body.groups.data, ambiguousId)).toEqual([
      ['vendor-shared', 1],
    ]);
  });

  test('the model filter selects what the bucket holds', async () => {
    const body = await aggregate(
      `group_by=model&model=fast&ai_provider_id=${aliasedId}`
    );
    expect(body.totals.event_count).toBe(3);
  });
});
