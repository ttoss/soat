import { db } from 'src/db';
import { flushAuditQueue } from 'src/lib/auditQueue';
import { snapshotProjectStorage } from 'src/lib/usageStorage';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { createQuotaRow } from '../../fixtures/quotaSeed';
import { authenticatedTestClient } from '../../testClient';

/**
 * The `storage_bytes` stock cap (#1249).
 *
 * A stock is not a flow: nothing resets, so the refusal is a `409` with no
 * `Retry-After`, and what clears it is deleting content. These drive the real
 * corpus write paths, because "the cap is wired to every caller-facing create"
 * is exactly the property a lib test could not establish — the enforcement
 * points are the whole feature.
 */

const ONE_MB = 1_000_000;

describe('Quotas — the storage_bytes stock cap', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let projectInternalId: number;
  let memoryId: string;
  let datasetId: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'quotastorage',
      policyActions: [
        'quotas:CreateQuota',
        'quotas:GetQuota',
        'quotas:ListQuotas',
        'quotas:UpdateQuota',
        'files:UploadFile',
        'files:CreateFile',
        'files:GetFile',
        'documents:CreateDocument',
        'documents:GetDocument',
        'documents:IngestDocument',
        'memories:CreateMemory',
        'memories:CreateMemoryEntry',
        'memories:GetMemory',
        'conversations:CreateConversation',
        'conversations:UpdateConversation',
        'conversations:GetConversation',
        'evaluations:CreateDataset',
        'evaluations:GetDataset',
      ],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;

    const project = await db.Project.findOne({
      where: { publicId: projectId },
    });
    projectInternalId = project!.id as number;

    const memoryRes = await authenticatedTestClient(userToken)
      .post('/api/v1/memories')
      .send({ project_id: projectId, name: 'storage cap memory' });
    memoryId = memoryRes.body.id;

    const datasetRes = await authenticatedTestClient(userToken)
      .post('/api/v1/datasets')
      .send({ project_id: projectId, name: 'storage cap dataset' });
    datasetId = datasetRes.body.id;
  });

  // The cap reads the last snapshot, so a test that needs a footprint seeds a
  // file and runs the sweep. `day` only distinguishes the idempotency key —
  // one storage event per project per UTC day — so each call needs its own.
  const snapshotWithStoredBytes = async (args: {
    bytes: number;
    day: string;
  }): Promise<void> => {
    await authenticatedTestClient(userToken)
      .post('/api/v1/files')
      .send({
        project_id: projectId,
        filename: `snapshot-${args.day}.bin`,
        size: args.bytes,
      });
    await snapshotProjectStorage({
      projectId: projectInternalId,
      projectPublicId: projectId,
      now: new Date(`${args.day}T00:00:00.000Z`),
    });
  };

  const deleteStorageQuotas = async (): Promise<void> => {
    await db.Quota.destroy({
      where: { projectId: projectInternalId, metric: 'storage_bytes' },
    });
  };

  describe('POST /api/v1/quotas', () => {
    afterEach(deleteStorageQuotas);

    test('creates a project-scope cap on the current footprint', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/quotas')
        .send({
          project_id: projectId,
          scope: 'project',
          metric: 'storage_bytes',
          window: 'current',
          limit: 5 * ONE_MB,
        });

      expect(response.status).toBe(201);
      expect(response.body.metric).toBe('storage_bytes');
      expect(response.body.window).toBe('current');
      expect(response.body.limit).toBe(5 * ONE_MB);
      // No pricing dependency, and no counter to report — a footprint is read
      // from the meter, not accumulated in `quota_window_counters`.
      expect(response.body.on_unpriced).toBeNull();
      expect(response.body.current_usage).toBeNull();
    });

    test('rejects a windowed storage cap, which would never be evaluated', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/quotas')
        .send({
          project_id: projectId,
          scope: 'project',
          metric: 'storage_bytes',
          window: 'calendar_month',
          limit: ONE_MB,
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(response.body.error.message).toMatch(/current/);
    });

    test('rejects window=current on a flow metric', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/quotas')
        .send({
          project_id: projectId,
          scope: 'project',
          metric: 'tokens',
          window: 'current',
          limit: 100,
        });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toMatch(/window/);
    });

    test.each(['api_key', 'agent', 'actor'])(
      'rejects scope=%s, which a stored byte carries no attribution for',
      async (scope) => {
        const response = await authenticatedTestClient(userToken)
          .post('/api/v1/quotas')
          .send({
            project_id: projectId,
            scope,
            metric: 'storage_bytes',
            window: 'current',
            limit: ONE_MB,
          });

        expect(response.status).toBe(400);
        expect(response.body.error.message).toMatch(/storage_bytes/);
      }
    );

    test('rejects a fractional byte limit', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/quotas')
        .send({
          project_id: projectId,
          scope: 'project',
          metric: 'storage_bytes',
          window: 'current',
          limit: 1.5,
        });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toMatch(/positive integer/);
    });
  });

  describe('enforcement on the corpus write paths', () => {
    beforeAll(async () => {
      await snapshotWithStoredBytes({ bytes: 4 * ONE_MB, day: '2026-01-02' });
    });

    afterEach(deleteStorageQuotas);

    const enforceOverCap = async (): Promise<void> => {
      await createQuotaRow({
        projectInternalId,
        scope: 'project',
        metric: 'storage_bytes',
        window: 'current',
        limit: ONE_MB,
      });
    };

    test('a file upload over the cap is refused with 409 and no Retry-After', async () => {
      await enforceOverCap();

      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/files/upload/base64')
        .send({
          project_id: projectId,
          filename: 'over-cap.txt',
          content: Buffer.from('too much').toString('base64'),
        });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('QUOTA_STORAGE_EXCEEDED');
      expect(response.body.error.meta.limit).toBe(ONE_MB);
      expect(response.body.error.meta.current_bytes).toBeGreaterThan(ONE_MB);
      // A stock never resets, so neither the header nor `resets_at` is sent.
      expect(response.headers['retry-after']).toBeUndefined();
      expect(response.body.error.meta.resets_at).toBeUndefined();
      // The hint has to name deleting content — waiting is not a remedy here.
      expect(response.body.error.hint).toMatch(/[Dd]elete/);
    });

    test('a metadata-only file create is refused too — its size is metered', async () => {
      await enforceOverCap();

      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/files')
        .send({
          project_id: projectId,
          filename: 'declared.bin',
          size: 10,
        });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('QUOTA_STORAGE_EXCEEDED');
    });

    test('a document create over the cap is refused', async () => {
      await enforceOverCap();

      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents')
        .send({ project_id: projectId, content: 'over the cap' });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('QUOTA_STORAGE_EXCEEDED');
    });

    test('a memory-entry create over the cap is refused', async () => {
      await enforceOverCap();

      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/memory-entries')
        .send({ memory_id: memoryId, content: 'over the cap' });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('QUOTA_STORAGE_EXCEEDED');
    });

    // A `dataset_items` row is summed by the storage snapshot (#1250), so a
    // fixture is a corpus write the cap has to bound like any other.
    test('a dataset-item create over the cap is refused', async () => {
      await enforceOverCap();

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/datasets/${datasetId}/items`)
        .send({ input: [{ role: 'user', content: 'over the cap' }] });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('QUOTA_STORAGE_EXCEEDED');
    });

    test('a dataset-item create under the cap is admitted', async () => {
      await createQuotaRow({
        projectInternalId,
        scope: 'project',
        metric: 'storage_bytes',
        window: 'current',
        limit: 500 * ONE_MB,
      });

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/datasets/${datasetId}/items`)
        .send({ input: [{ role: 'user', content: 'under the cap' }] });

      expect(response.status).toBe(201);
    });

    test('an ingest of an already-stored file is refused', async () => {
      const fileRes = await authenticatedTestClient(userToken)
        .post('/api/v1/files/upload/base64')
        .send({
          project_id: projectId,
          filename: 'ingestible.txt',
          content_type: 'text/plain',
          content: Buffer.from('one two three').toString('base64'),
        });
      expect(fileRes.status).toBe(201);

      await enforceOverCap();

      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents/ingest')
        .send({ file_id: fileRes.body.id, project_id: projectId });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('QUOTA_STORAGE_EXCEEDED');
    });

    test('a conversation message still persists while the project is capped', async () => {
      await enforceOverCap();

      const convRes = await authenticatedTestClient(userToken)
        .post('/api/v1/conversations')
        .send({ project_id: projectId });
      expect(convRes.status).toBe(201);

      // Every message is a Document with its own chunks, so the shared
      // `createDocument` is deliberately not where the cap sits: refusing here
      // would fail a generation mid-turn.
      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/conversations/${convRes.body.id}/messages`)
        .send({ message: 'still allowed', role: 'user' });

      expect(response.status).toBe(201);
    });

    test('monitor mode observes without blocking', async () => {
      await createQuotaRow({
        projectInternalId,
        scope: 'project',
        metric: 'storage_bytes',
        window: 'current',
        limit: ONE_MB,
        mode: 'monitor',
      });

      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents')
        .send({ project_id: projectId, content: 'monitored, not blocked' });

      expect(response.status).toBe(201);
    });

    test('a monitor breach leaves an audit entry naming the measured footprint', async () => {
      const quota = await createQuotaRow({
        projectInternalId,
        scope: 'project',
        metric: 'storage_bytes',
        window: 'current',
        limit: ONE_MB,
        mode: 'monitor',
      });

      await authenticatedTestClient(userToken)
        .post('/api/v1/documents')
        .send({ project_id: projectId, content: 'audited monitor breach' });

      await flushAuditQueue();

      const entries = await authenticatedTestClient(adminToken)
        .get('/api/v1/audit-log')
        .query({ project_id: projectId, action: 'quotas:MonitorBreach' });

      expect(entries.status).toBe(200);
      const entry = entries.body.data.find(
        (row: { resource_public_id?: string }) => {
          return row.resource_public_id === quota.publicId;
        }
      );
      expect(entry).toBeDefined();
      expect(entry.detail.kind).toBe('quota_monitor_breach');
      expect(entry.detail.metric).toBe('storage_bytes');
      // The measured footprint, not a counter — the whole point of a dry run.
      expect(entry.detail.observed_value).toBeGreaterThan(ONE_MB);
      // A stock has no window, so the measurement's own UTC day stands in as
      // the fire key: a fresh snapshot re-reports a project that is still over,
      // where a fixed `current` key would report once and never again.
      expect(entry.detail.window_key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    test('a write under the cap is admitted', async () => {
      await createQuotaRow({
        projectInternalId,
        scope: 'project',
        metric: 'storage_bytes',
        window: 'current',
        limit: 500 * ONE_MB,
      });

      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents')
        .send({ project_id: projectId, content: 'well under the cap' });

      expect(response.status).toBe(201);
    });

    test('a project with no storage quota is never refused', async () => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents')
        .send({ project_id: projectId, content: 'uncapped' });

      expect(response.status).toBe(201);
    });
  });

  describe('a project the sweep has never metered', () => {
    let freshProjectId: string;
    let freshInternalId: number;

    beforeAll(async () => {
      const projectRes = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'quotastorage unmetered' });
      freshProjectId = projectRes.body.id;
      const project = await db.Project.findOne({
        where: { publicId: freshProjectId },
      });
      freshInternalId = project!.id as number;
    });

    test('a single upload larger than the whole cap is still refused', async () => {
      await createQuotaRow({
        projectInternalId: freshInternalId,
        scope: 'project',
        metric: 'storage_bytes',
        window: 'current',
        limit: 8,
      });

      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/files/upload/base64')
        .send({
          project_id: freshProjectId,
          filename: 'big.txt',
          content: Buffer.from('more than eight bytes').toString('base64'),
        });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('QUOTA_STORAGE_EXCEEDED');
      expect(response.body.error.meta.current_bytes).toBe(21);
    });

    test('a write within the cap is admitted with no snapshot to read', async () => {
      const response = await authenticatedTestClient(adminToken)
        .post('/api/v1/files/upload/base64')
        .send({
          project_id: freshProjectId,
          filename: 'small.txt',
          content: Buffer.from('tiny').toString('base64'),
        });

      expect(response.status).toBe(201);
    });
  });
});
