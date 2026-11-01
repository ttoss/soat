import { db } from 'src/db';
import { EMBEDDING_USAGE_SOURCE } from 'src/lib/usageEmbeddingRecording';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { createQuotaRow, seedUsageEvent } from '../../fixtures/quotaSeed';
import { authenticatedTestClient } from '../../testClient';

/**
 * A content edit re-embeds and stores new text, so it passes the same
 * `storage_bytes` cap and token/cost quotas as a create. An edit that leaves
 * content alone embeds nothing and is admitted.
 */

type Fresh = { projectPublicId: string; projectInternalId: number };

const STORAGE_LIMIT = 8;
const LONG_TEXT = 'more than eight bytes of text';

describe('quotas on content edits', () => {
  let adminToken: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'editquota',
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

  const overBudget = async (ctx: Fresh): Promise<string> => {
    await seedUsageEvent({
      projectInternalId: ctx.projectInternalId,
      costUsd: '3.00',
    });
    const res = await client().post('/api/v1/quotas').send({
      project_id: ctx.projectPublicId,
      scope: 'project',
      metric: 'cost_usd',
      window: 'calendar_month',
      limit: 1,
    });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const storageCap = async (ctx: Fresh): Promise<void> => {
    await createQuotaRow({
      projectInternalId: ctx.projectInternalId,
      scope: 'project',
      metric: 'storage_bytes',
      window: 'current',
      limit: STORAGE_LIMIT,
    });
  };

  const embeddingMeters = (ctx: Fresh): Promise<number> => {
    return db.UsageEvent.count({
      where: {
        projectId: ctx.projectInternalId,
        source: EMBEDDING_USAGE_SOURCE,
      },
    });
  };

  const expectSpendRefused = (
    res: { status: number; body: { error?: unknown } },
    quotaId: string
  ) => {
    expect(res.status).toBe(429);
    expect(res.body.error).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      meta: { quota_id: quotaId, metric: 'cost_usd' },
    });
  };

  const expectStorageRefused = (res: {
    status: number;
    body: { error?: { code?: string } };
  }) => {
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('QUOTA_STORAGE_EXCEEDED');
  };

  const createDocument = async (ctx: Fresh, content: string) => {
    const res = await client()
      .post('/api/v1/documents')
      .send({ project_id: ctx.projectPublicId, content });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const createMemory = async (ctx: Fresh, content: string) => {
    const store = await client()
      .post('/api/v1/memory-stores')
      .send({ project_id: ctx.projectPublicId, name: 'edit quota store' });
    expect(store.status).toBe(201);
    const res = await client()
      .post('/api/v1/memories')
      .send({ memory_store_id: store.body.id, content });
    expect(res.status).toBe(201);
    return { memoryId: res.body.id as string, storeId: store.body.id };
  };

  describe('PATCH /api/v1/documents/{document_id}', () => {
    test('new content over the cost quota is refused before it embeds', async () => {
      const ctx = await freshProject('editquota-doc-patch-spend');
      const docId = await createDocument(ctx, 'original');
      const quotaId = await overBudget(ctx);
      const metersBefore = await embeddingMeters(ctx);

      const res = await client()
        .patch(`/api/v1/documents/${docId}`)
        .send({ content: 'edited over budget' });

      expectSpendRefused(res, quotaId);
      expect(await embeddingMeters(ctx)).toBe(metersBefore);
      const doc = await client().get(`/api/v1/documents/${docId}`);
      expect(doc.body.content).toBe('original');
    });

    test('new content over the storage cap is refused', async () => {
      const ctx = await freshProject('editquota-doc-patch-storage');
      const docId = await createDocument(ctx, 'tiny');
      await storageCap(ctx);

      const res = await client()
        .patch(`/api/v1/documents/${docId}`)
        .send({ content: LONG_TEXT });

      expectStorageRefused(res);
    });

    test('an edit without content is admitted over both caps', async () => {
      const ctx = await freshProject('editquota-doc-patch-title');
      const docId = await createDocument(ctx, 'tiny');
      await overBudget(ctx);
      await storageCap(ctx);

      const res = await client()
        .patch(`/api/v1/documents/${docId}`)
        .send({ title: 'renamed' });

      expect(res.status).toBe(200);
      expect(res.body.title).toBe('renamed');
    });
  });

  describe('POST /api/v1/documents/{document_id}/versions/{version}/restore', () => {
    const editedDocument = async (ctx: Fresh, original: string) => {
      const docId = await createDocument(ctx, original);
      const edited = await client()
        .patch(`/api/v1/documents/${docId}`)
        .send({ content: 'second' });
      expect(edited.status).toBe(200);
      return docId;
    };

    test('a restore over the cost quota is refused before it embeds', async () => {
      const ctx = await freshProject('editquota-doc-restore-spend');
      const docId = await editedDocument(ctx, 'first');
      const quotaId = await overBudget(ctx);
      const metersBefore = await embeddingMeters(ctx);

      const res = await client()
        .post(`/api/v1/documents/${docId}/versions/1/restore`)
        .send({});

      expectSpendRefused(res, quotaId);
      expect(await embeddingMeters(ctx)).toBe(metersBefore);
    });

    test('a restore over the storage cap is refused', async () => {
      const ctx = await freshProject('editquota-doc-restore-storage');
      const docId = await editedDocument(ctx, LONG_TEXT);
      await storageCap(ctx);

      const res = await client()
        .post(`/api/v1/documents/${docId}/versions/1/restore`)
        .send({});

      expectStorageRefused(res);
    });

    test('a restore under both caps is admitted', async () => {
      const ctx = await freshProject('editquota-doc-restore-ok');
      const docId = await editedDocument(ctx, 'first');

      const res = await client()
        .post(`/api/v1/documents/${docId}/versions/1/restore`)
        .send({});

      expect(res.status).toBe(200);
    });
  });

  describe('PUT /api/v1/memories/{memory_id}', () => {
    test('new content over the cost quota is refused before it embeds', async () => {
      const ctx = await freshProject('editquota-memory-spend');
      const { memoryId } = await createMemory(ctx, 'original');
      const quotaId = await overBudget(ctx);
      const metersBefore = await embeddingMeters(ctx);

      const res = await client()
        .put(`/api/v1/memories/${memoryId}`)
        .send({ content: 'edited over budget' });

      expectSpendRefused(res, quotaId);
      expect(await embeddingMeters(ctx)).toBe(metersBefore);
    });

    test('new content over the storage cap is refused', async () => {
      const ctx = await freshProject('editquota-memory-storage');
      const { memoryId } = await createMemory(ctx, 'tiny');
      await storageCap(ctx);

      const res = await client()
        .put(`/api/v1/memories/${memoryId}`)
        .send({ content: LONG_TEXT });

      expectStorageRefused(res);
    });

    test('a tags-only edit is admitted over both caps', async () => {
      const ctx = await freshProject('editquota-memory-tags');
      const { memoryId } = await createMemory(ctx, 'tiny');
      await overBudget(ctx);
      await storageCap(ctx);

      const res = await client()
        .put(`/api/v1/memories/${memoryId}`)
        .send({ tags: { topic: 'quota' } });

      expect(res.status).toBe(200);
    });
  });

  describe('formation update', () => {
    const deploy = (ctx: Fresh, resources: Record<string, unknown>) => {
      return client()
        .post('/api/v1/formations')
        .send({
          project_id: ctx.projectPublicId,
          name: `editquota-${Date.now()}`,
          template: { resources },
        });
    };

    const update = (
      formationId: string,
      resources: Record<string, unknown>
    ) => {
      return client()
        .put(`/api/v1/formations/${formationId}`)
        .send({ template: { resources } });
    };

    test('a declared document whose content changes is refused', async () => {
      const ctx = await freshProject('editquota-formation-doc');
      const created = await deploy(ctx, {
        Doc: { type: 'document', properties: { content: 'original' } },
      });
      expect(created.body.status).toBe('active');
      await overBudget(ctx);
      const metersBefore = await embeddingMeters(ctx);

      const res = await update(created.body.id, {
        Doc: { type: 'document', properties: { content: 'over budget' } },
      });

      expect(res.body.status).toBe('failed');
      expect(await embeddingMeters(ctx)).toBe(metersBefore);
    });

    test('a declared memory whose content changes is refused', async () => {
      const ctx = await freshProject('editquota-formation-memory');
      const store = await client()
        .post('/api/v1/memory-stores')
        .send({ project_id: ctx.projectPublicId, name: 'formation store' });
      const fact = (content: string) => {
        return {
          Fact: {
            type: 'memory',
            properties: { memory_store_id: store.body.id, content },
          },
        };
      };
      const created = await deploy(ctx, fact('original'));
      expect(created.body.status).toBe('active');
      await storageCap(ctx);

      const res = await update(created.body.id, fact(LONG_TEXT));

      expect(res.body.status).toBe('failed');
    });
  });
});
