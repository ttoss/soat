import { randomBytes } from 'node:crypto';

import { db } from 'src/db';
import {
  lastSnapshotStoredBytes,
  snapshotProjectStorage,
} from 'src/lib/usageStorage';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { createQuotaRow } from '../../fixtures/quotaSeed';
import { authenticatedTestClient } from '../../testClient';

/** What bounds a collection: the storage cap, the meter and the query timeout. */
describe('Collection limits', () => {
  let userToken: string;
  let projectId: string;
  let projectInternalId: number;
  let collectionId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'colllimits',
      policyActions: ['collections:*'],
      createNoPermUser: false,
    });
    userToken = setup.userToken;
    projectId = setup.projectId;
    const project = await db.Project.findOne({
      where: { publicId: projectId },
    });
    projectInternalId = project!.id as number;

    const collection = await authenticatedTestClient(userToken)
      .post('/api/v1/collections')
      .send({ project_id: projectId, name: 'limits' });
    collectionId = collection.body.id;
  }, 60_000);

  const put = (key: string, data: object) => {
    return authenticatedTestClient(userToken)
      .put(`/api/v1/collections/${collectionId}/items/${key}`)
      .send({ data });
  };

  test('the daily storage snapshot measures item bytes', async () => {
    // Incompressible, since the meter reads the stored (TOAST-compressed) width.
    await put('measured', { blob: randomBytes(3000).toString('base64') });

    await snapshotProjectStorage({
      projectId: projectInternalId,
      projectPublicId: projectId,
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    const snapshot = await lastSnapshotStoredBytes({
      projectId: projectInternalId,
    });
    expect(snapshot!.bytes).toBeGreaterThanOrEqual(3000);
  });

  describe('with a storage_bytes cap', () => {
    afterEach(async () => {
      await db.Quota.destroy({
        where: { projectId: projectInternalId, metric: 'storage_bytes' },
      });
    });

    test('refuses a put that would cross it', async () => {
      await createQuotaRow({
        projectInternalId,
        scope: 'project',
        metric: 'storage_bytes',
        window: 'current',
        limit: 10,
      });

      const response = await put('capped', { note: 'more than ten bytes' });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('QUOTA_STORAGE_EXCEEDED');
    });

    test('refuses a merge that would cross it', async () => {
      await put('merged', { n: 1 });
      await createQuotaRow({
        projectInternalId,
        scope: 'project',
        metric: 'storage_bytes',
        window: 'current',
        limit: 10,
      });

      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/collections/${collectionId}/items/merged`)
        .send({ data: { note: 'more than ten bytes' } });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('QUOTA_STORAGE_EXCEEDED');
    });
  });

  describe('the query timeout', () => {
    const previous = process.env.COLLECTION_QUERY_TIMEOUT_MS;

    afterEach(() => {
      if (previous === undefined) {
        delete process.env.COLLECTION_QUERY_TIMEOUT_MS;
      } else {
        process.env.COLLECTION_QUERY_TIMEOUT_MS = previous;
      }
    });

    test('cancels a listing that runs past it', async () => {
      const collection = await db.Collection.findOne({
        where: { publicId: collectionId },
      });
      // Volume a request-by-request setup cannot reach in a test's budget.
      await db.sequelize.query(
        `INSERT INTO "collection_items"
           ("collection_id", "key", "data", "version", "created_at", "updated_at")
         SELECT :collectionId, 'bulk-' || n, jsonb_build_object('n', n), 1, now(), now()
           FROM generate_series(1, 200000) AS n`,
        { replacements: { collectionId: collection!.id } }
      );
      process.env.COLLECTION_QUERY_TIMEOUT_MS = '1';

      const data = encodeURIComponent(JSON.stringify({ n: { gte: 199990 } }));
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/collections/${collectionId}/items?data=${data}`
      );

      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('QUERY_TIMEOUT');
      expect(response.body.error.meta.timeout_ms).toBe(1);
    });
  });
});
