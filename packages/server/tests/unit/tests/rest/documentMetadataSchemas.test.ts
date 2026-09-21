import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

const DOCUMENT_ACTIONS = [
  'documents:CreateDocument',
  'documents:GetDocument',
  'documents:ListDocuments',
  'documents:UpdateDocument',
  'documents:RestoreDocumentVersion',
];

/**
 * A project may declare what `metadata` must look like under a path prefix, so
 * a corpus many writers share can be read as structured data rather than as
 * whatever each writer happened to attach.
 */
describe('Document metadata schemas', () => {
  let adminToken: string;
  let userToken: string;
  let projectId: string;
  let seq = 0;

  const REPORT_SCHEMA = {
    type: 'object',
    properties: {
      quarter: { type: 'string', enum: ['Q1', 'Q2', 'Q3', 'Q4'] },
      owner: { type: 'string', minLength: 1 },
    },
    required: ['quarter'],
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'docmetaschema',
      policyActions: DOCUMENT_ACTIONS,
    });

    adminToken = setup.adminToken;
    userToken = setup.userToken;
    projectId = setup.projectId;
  }, 60_000);

  /** Replaces the project's declared schemas; `null` clears them. */
  const declare = (metadataSchemas: unknown) => {
    return authenticatedTestClient(adminToken)
      .patch(`/api/v1/projects/${projectId}`)
      .send({ metadata_schemas: metadataSchemas });
  };

  const declareReportSchema = async () => {
    const response = await declare([
      { path_prefix: '/reports', schema: REPORT_SCHEMA },
    ]);
    expect(response.status).toBe(200);
  };

  /**
   * `path` names the directory; the leaf is unique per call, because a project
   * addresses a document by its path and a repeat would be a conflict rather
   * than a second document.
   */
  const createDocument = (args: { path: string; metadata?: unknown }) => {
    seq += 1;
    return authenticatedTestClient(userToken)
      .post('/api/v1/documents')
      .send({
        project_id: projectId,
        content: 'Revenue is up.',
        filename: `doc-${seq}.txt`,
        path: `${args.path}/doc-${seq}.txt`,
        ...(args.metadata === undefined ? {} : { metadata: args.metadata }),
      });
  };

  afterEach(async () => {
    expect((await declare(null)).status).toBe(200);
  });

  describe('PATCH /api/v1/projects/:project_id', () => {
    test('stores the declared schemas and reads them back', async () => {
      const response = await declare([
        { path_prefix: '/reports', schema: REPORT_SCHEMA },
      ]);

      expect(response.status).toBe(200);
      expect(response.body.metadata_schemas).toEqual([
        { path_prefix: '/reports', schema: REPORT_SCHEMA },
      ]);

      const read = await authenticatedTestClient(adminToken).get(
        `/api/v1/projects/${projectId}`
      );
      expect(read.body.metadata_schemas).toEqual([
        { path_prefix: '/reports', schema: REPORT_SCHEMA },
      ]);
    });

    test('clears them with null', async () => {
      await declareReportSchema();

      const response = await declare(null);

      expect(response.status).toBe(200);
      expect(response.body.metadata_schemas).toBeNull();
    });

    test('refuses a schema JSON Schema cannot compile', async () => {
      const response = await declare([
        { path_prefix: '/reports', schema: { type: 'nonsense' } },
      ]);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('refuses an entry that is not a prefix and a schema', async () => {
      expect((await declare('/reports')).status).toBe(400);
      expect((await declare([{ schema: REPORT_SCHEMA }])).status).toBe(400);
      expect((await declare([{ path_prefix: '/reports' }])).status).toBe(400);
      expect(
        (await declare([{ path_prefix: '', schema: REPORT_SCHEMA }])).status
      ).toBe(400);
      expect(
        (await declare([{ path_prefix: '/reports', schema: 'object' }])).status
      ).toBe(400);
      // Resolves above the root, so it names no location to govern.
      expect(
        (await declare([{ path_prefix: '/..', schema: REPORT_SCHEMA }])).status
      ).toBe(400);
    });

    test('refuses two schemas for one prefix', async () => {
      const response = await declare([
        { path_prefix: '/reports', schema: REPORT_SCHEMA },
        { path_prefix: '/reports/', schema: { type: 'object' } },
      ]);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('refuses a prefix under the reserved root', async () => {
      const response = await declare([
        { path_prefix: '/.system/traces', schema: REPORT_SCHEMA },
      ]);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('POST /api/v1/documents', () => {
    test('stores metadata that satisfies the prefix schema', async () => {
      await declareReportSchema();

      const response = await createDocument({
        path: '/reports',
        metadata: { quarter: 'Q1', owner: 'finance' },
      });

      expect(response.status).toBe(201);
      expect(response.body.metadata).toEqual({
        quarter: 'Q1',
        owner: 'finance',
      });
    });

    test('refuses metadata the prefix schema rejects', async () => {
      await declareReportSchema();

      const response = await createDocument({
        path: '/reports',
        metadata: { quarter: 'Q5' },
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(response.body.error.meta.path_prefix).toBe('/reports');
    });

    test('refuses metadata missing a required field', async () => {
      await declareReportSchema();

      const response = await createDocument({
        path: '/reports',
        metadata: { owner: 'finance' },
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('leaves a document that carries no metadata alone', async () => {
      await declareReportSchema();

      const response = await createDocument({ path: '/reports' });

      expect(response.status).toBe(201);
      expect(response.body.metadata).toBeUndefined();
    });

    test('governs nothing outside the prefix', async () => {
      await declareReportSchema();

      const response = await createDocument({
        path: '/notes',
        metadata: { quarter: 'Q5' },
      });

      expect(response.status).toBe(201);
    });

    test('a prefix is a path boundary, not a substring', async () => {
      await declareReportSchema();

      const response = await createDocument({
        path: '/reports-archive',
        metadata: { quarter: 'Q5' },
      });

      expect(response.status).toBe(201);
    });

    test('the longest declared prefix decides', async () => {
      const declared = await declare([
        { path_prefix: '/reports', schema: REPORT_SCHEMA },
        {
          path_prefix: '/reports/legal',
          schema: {
            type: 'object',
            properties: { counsel: { type: 'string' } },
            required: ['counsel'],
          },
        },
      ]);
      expect(declared.status).toBe(200);

      // Satisfies the outer schema and not the inner one: the inner is the
      // schema in force, so this is refused.
      const refused = await createDocument({
        path: '/reports/legal',
        metadata: { quarter: 'Q1' },
      });
      expect(refused.status).toBe(400);
      expect(refused.body.error.meta.path_prefix).toBe('/reports/legal');

      // And the inner schema alone is enough, though it violates the outer's
      // `quarter` enum — one schema governs a document, never two.
      const accepted = await createDocument({
        path: '/reports/legal',
        metadata: { counsel: 'external', quarter: 'Q9' },
      });
      expect(accepted.status).toBe(201);
    });
  });

  describe('PATCH /api/v1/documents/:document_id', () => {
    test('refuses metadata the prefix schema rejects', async () => {
      await declareReportSchema();
      const created = await createDocument({
        path: '/reports',
        metadata: { quarter: 'Q3' },
      });
      expect(created.status).toBe(201);

      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/documents/${created.body.id}`)
        .send({ metadata: { quarter: 'Q13' } });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('refuses clearing metadata a required field governs', async () => {
      await declareReportSchema();
      const created = await createDocument({
        path: '/reports',
        metadata: { quarter: 'Q4' },
      });
      expect(created.status).toBe(201);

      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/documents/${created.body.id}`)
        .send({ metadata: null });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('refuses a move into a prefix the metadata does not satisfy', async () => {
      await declareReportSchema();
      const created = await createDocument({
        path: '/notes',
        metadata: { note: 'unstructured' },
      });
      expect(created.status).toBe(201);

      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/documents/${created.body.id}`)
        .send({ path: '/reports/draft.txt' });

      expect(response.status).toBe(400);
      expect(response.body.error.meta.path_prefix).toBe('/reports');
    });

    test('accepts a write that leaves the pair satisfying the schema', async () => {
      await declareReportSchema();
      const created = await createDocument({
        path: '/reports',
        metadata: { quarter: 'Q1' },
      });
      expect(created.status).toBe(201);

      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/documents/${created.body.id}`)
        .send({ metadata: { quarter: 'Q2', owner: 'finance' } });

      expect(response.status).toBe(200);
      expect(response.body.metadata).toEqual({
        quarter: 'Q2',
        owner: 'finance',
      });
    });

    test('refuses restoring a version the schema no longer accepts', async () => {
      const created = await createDocument({
        path: '/reports',
        metadata: { quarter: 'Q9' },
      });
      expect(created.status).toBe(201);

      // Tightened after the fact: the archived version holds metadata the
      // project no longer accepts, and a restore is a write like any other.
      await declareReportSchema();

      const response = await authenticatedTestClient(userToken)
        .post(`/api/v1/documents/${created.body.id}/versions/1/restore`)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a write touching neither path nor metadata is not re-judged', async () => {
      const created = await createDocument({
        path: '/reports',
        metadata: { quarter: 'Q9' },
      });
      expect(created.status).toBe(201);

      // Declared only now, so the stored pair never passed it.
      await declareReportSchema();

      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/documents/${created.body.id}`)
        .send({ title: 'Legacy report' });

      expect(response.status).toBe(200);
      expect(response.body.title).toBe('Legacy report');
    });
  });
});
