import { db } from 'src/db';
import { createEmbeddings, embedForProject } from 'src/lib/embeddings';
import { assertMemorySpendWithinQuota } from 'src/lib/memories';
import { EMBEDDING_USAGE_SOURCE } from 'src/lib/usageEmbeddingRecording';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { seedUsageEvent } from '../../fixtures/quotaSeed';
import { authenticatedTestClient } from '../../testClient';

/**
 * Token and cost quotas on the caller-facing entry points that embed with no
 * generation behind them. Each is refused with `429` before anything is
 * written or embedded; embeddings a run makes (conversation messages) are not.
 */

type Fresh = { projectPublicId: string; projectInternalId: number };

describe('token and cost quotas on embedding spend', () => {
  let adminToken: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'embedquota',
      policyActions: [],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
  });

  const client = () => {
    return authenticatedTestClient(adminToken);
  };

  const freshProject = async (name: string): Promise<Fresh> => {
    const res = await client().post('/api/v1/projects').send({ name });
    expect(res.status).toBe(201);
    const project = await db.Project.findOne({
      where: { publicId: res.body.id },
    });
    return {
      projectPublicId: res.body.id,
      projectInternalId: project!.id as number,
    };
  };

  const spendCost = async (ctx: Fresh): Promise<void> => {
    await seedUsageEvent({
      projectInternalId: ctx.projectInternalId,
      costUsd: '3.00',
    });
  };

  const costQuota = async (
    ctx: Fresh,
    body: Record<string, unknown> = {}
  ): Promise<string> => {
    const res = await client()
      .post('/api/v1/quotas')
      .send({
        project_id: ctx.projectPublicId,
        scope: 'project',
        metric: 'cost_usd',
        window: 'calendar_month',
        limit: 1,
        ...body,
      });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const overBudget = async (name: string) => {
    const ctx = await freshProject(name);
    await spendCost(ctx);
    const quotaId = await costQuota(ctx);
    return { ctx, quotaId };
  };

  const embeddingMeters = (ctx: Fresh): Promise<number> => {
    return db.UsageEvent.count({
      where: {
        projectId: ctx.projectInternalId,
        source: EMBEDDING_USAGE_SOURCE,
      },
    });
  };

  const expectRefused = (
    res: { status: number; body: { error?: unknown } },
    quotaId: string
  ) => {
    expect(res.status).toBe(429);
    expect(res.body.error).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      meta: { quota_id: quotaId, metric: 'cost_usd' },
    });
  };

  const uploadTextFile = async (ctx: Fresh, filename: string) => {
    const res = await client()
      .post('/api/v1/files/upload/base64')
      .send({
        project_id: ctx.projectPublicId,
        filename,
        content_type: 'text/plain',
        content: Buffer.from('one two three').toString('base64'),
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const memoryStore = async (ctx: Fresh): Promise<string> => {
    const res = await client()
      .post('/api/v1/memory-stores')
      .send({ project_id: ctx.projectPublicId, name: 'embed quota store' });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  describe('POST /api/v1/embeddings', () => {
    test('a spent project budget refuses the call', async () => {
      const { ctx, quotaId } = await overBudget('embedquota-embeddings');

      const res = await client()
        .post('/api/v1/embeddings')
        .send({ project_id: ctx.projectPublicId, input: 'hello world' });

      expectRefused(res, quotaId);
      expect(await embeddingMeters(ctx)).toBe(0);
    });

    test('a budget under its limit admits the call', async () => {
      const ctx = await freshProject('embedquota-embeddings-under');
      await spendCost(ctx);
      await costQuota(ctx, { limit: 100 });

      const res = await client()
        .post('/api/v1/embeddings')
        .send({ project_id: ctx.projectPublicId, input: 'hello world' });

      expect(res.status).toBe(200);
    });

    test('a monitor budget never refuses', async () => {
      const ctx = await freshProject('embedquota-embeddings-monitor');
      await spendCost(ctx);
      await costQuota(ctx, { mode: 'monitor' });

      const res = await client()
        .post('/api/v1/embeddings')
        .send({ project_id: ctx.projectPublicId, input: 'hello world' });

      expect(res.status).toBe(200);
    });

    test('an embedding billed to no project has no budget to refuse', async () => {
      await expect(
        createEmbeddings({ inputs: ['hello world'], projectPublicId: null })
      ).resolves.toHaveLength(1);
      await expect(
        createEmbeddings({
          inputs: ['hello world'],
          projectPublicId: 'proj_unknown',
        })
      ).resolves.toHaveLength(1);
    });
  });

  describe('POST /api/v1/knowledge/search', () => {
    test('a query to embed is refused', async () => {
      const { ctx, quotaId } = await overBudget('embedquota-search');

      const res = await client()
        .post('/api/v1/knowledge/search')
        .send({ project_id: ctx.projectPublicId, query: 'anything' });

      expectRefused(res, quotaId);
      expect(await embeddingMeters(ctx)).toBe(0);
    });

    test('a search with no query embeds nothing and is admitted', async () => {
      const { ctx } = await overBudget('embedquota-search-noquery');

      const res = await client()
        .post('/api/v1/knowledge/search')
        .send({ project_id: ctx.projectPublicId, document_paths: ['/'] });

      expect(res.status).toBe(200);
    });
  });

  describe('documents', () => {
    test('POST /documents is refused before the document is written', async () => {
      const { ctx, quotaId } = await overBudget('embedquota-doc-create');

      const res = await client()
        .post('/api/v1/documents')
        .send({ project_id: ctx.projectPublicId, content: 'over budget' });

      expectRefused(res, quotaId);
      expect(
        await db.Document.count({
          include: [
            {
              model: db.File,
              as: 'file',
              where: { projectId: ctx.projectInternalId },
            },
          ],
        })
      ).toBe(0);
    });

    test('POST /documents/ingest is refused', async () => {
      const ctx = await freshProject('embedquota-doc-ingest');
      const fileId = await uploadTextFile(ctx, 'ingest.txt');
      await spendCost(ctx);
      const quotaId = await costQuota(ctx);

      const res = await client()
        .post('/api/v1/documents/ingest')
        .send({ file_id: fileId, project_id: ctx.projectPublicId });

      expectRefused(res, quotaId);
      expect(await embeddingMeters(ctx)).toBe(0);
    });

    test('POST /documents/{document_id}/ingest is refused', async () => {
      const ctx = await freshProject('embedquota-doc-reingest');
      const fileId = await uploadTextFile(ctx, 'reingest.txt');
      const ingested = await client()
        .post('/api/v1/documents/ingest?wait=true')
        .send({ file_id: fileId, project_id: ctx.projectPublicId });
      expect(ingested.status).toBe(201);
      await spendCost(ctx);
      const quotaId = await costQuota(ctx);
      const metersBefore = await embeddingMeters(ctx);

      const res = await client()
        .post(`/api/v1/documents/${ingested.body.id}/ingest`)
        .send({});

      expectRefused(res, quotaId);
      expect(await embeddingMeters(ctx)).toBe(metersBefore);
    });

    test('a monitor budget never refuses', async () => {
      const ctx = await freshProject('embedquota-doc-monitor');
      await spendCost(ctx);
      await costQuota(ctx, { mode: 'monitor' });

      const res = await client()
        .post('/api/v1/documents')
        .send({ project_id: ctx.projectPublicId, content: 'monitored' });

      expect(res.status).toBe(201);
    });
  });

  describe('POST /api/v1/memories', () => {
    test('a spent project budget refuses the write', async () => {
      const ctx = await freshProject('embedquota-memory');
      const memoryStoreId = await memoryStore(ctx);
      await spendCost(ctx);
      const quotaId = await costQuota(ctx);

      const res = await client()
        .post('/api/v1/memories')
        .send({ memory_store_id: memoryStoreId, content: 'over budget' });

      expectRefused(res, quotaId);
      expect(await embeddingMeters(ctx)).toBe(0);
    });

    test('a store with no project has no budget to refuse', async () => {
      await expect(
        assertMemorySpendWithinQuota({ memoryStoreId: 2147483647 })
      ).resolves.toBeUndefined();
    });
  });

  describe('formations', () => {
    const deploy = (ctx: Fresh, resources: Record<string, unknown>) => {
      return client()
        .post('/api/v1/formations')
        .send({
          project_id: ctx.projectPublicId,
          name: `embedquota-${Date.now()}`,
          template: { resources },
        });
    };

    test('a declared document is refused', async () => {
      const { ctx } = await overBudget('embedquota-formation-doc');

      const res = await deploy(ctx, {
        Doc: { type: 'document', properties: { content: 'over budget' } },
      });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('failed');
      expect(res.body.resources[0].status).toBe('failed');
      expect(await embeddingMeters(ctx)).toBe(0);
    });

    test('a declared memory is refused', async () => {
      const ctx = await freshProject('embedquota-formation-memory');
      const memoryStoreId = await memoryStore(ctx);
      await spendCost(ctx);
      await costQuota(ctx);

      const res = await deploy(ctx, {
        Fact: {
          type: 'memory',
          properties: {
            memory_store_id: memoryStoreId,
            content: 'over budget',
          },
        },
      });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('failed');
      expect(await embeddingMeters(ctx)).toBe(0);
    });
  });

  describe('eval embedding scorer', () => {
    test('a spent project budget rejects the scorer embedding', async () => {
      const { ctx, quotaId } = await overBudget('embedquota-eval');

      await expect(
        embedForProject({
          projectId: ctx.projectInternalId,
          texts: ['output', 'expected'],
        })
      ).rejects.toMatchObject({
        code: 'QUOTA_EXCEEDED',
        meta: { quota_id: quotaId },
      });
      expect(await embeddingMeters(ctx)).toBe(0);
    });
  });

  test('a conversation message still embeds while the project is over budget', async () => {
    const { ctx } = await overBudget('embedquota-conversation');

    const conversation = await client()
      .post('/api/v1/conversations')
      .send({ project_id: ctx.projectPublicId });
    expect(conversation.status).toBe(201);

    const res = await client()
      .post(`/api/v1/conversations/${conversation.body.id}/messages`)
      .send({ message: 'still allowed', role: 'user' });

    expect(res.status).toBe(201);
  });
});
