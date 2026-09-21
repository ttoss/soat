import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

const ACTIONS = [
  'documents:CreateDocument',
  'documents:GetDocument',
  'documents:ListDocuments',
  'documents:UpdateDocument',
  'documents:RestoreDocumentVersion',
  'metadata-schemas:ListMetadataSchemas',
  'metadata-schemas:CreateMetadataSchema',
  'metadata-schemas:DeleteMetadataSchema',
];

/**
 * The gate: a declared schema is what a document write is judged against, at
 * every door a document's metadata is written through.
 */
describe('Document metadata schema enforcement', () => {
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
      policyActions: ACTIONS,
    });

    userToken = setup.userToken;
    projectId = setup.projectId;
  }, 60_000);

  const declare = (body: object) => {
    return authenticatedTestClient(userToken)
      .post('/api/v1/metadata-schemas')
      .send({ project_id: projectId, resource_type: 'document', ...body });
  };

  const declareReportSchema = async () => {
    const response = await declare({
      path_prefix: '/reports',
      schema: REPORT_SCHEMA,
    });
    expect(response.status).toBe(201);
  };

  /**
   * Every declaration in the project, cleared between tests: a rule left behind
   * would govern the next test's writes.
   */
  const clearDeclarations = async () => {
    const listed = await authenticatedTestClient(userToken).get(
      `/api/v1/metadata-schemas?project_id=${projectId}&limit=100`
    );
    expect(listed.status).toBe(200);

    for (const declaration of listed.body.data as { id: string }[]) {
      const deleted = await authenticatedTestClient(userToken).delete(
        `/api/v1/metadata-schemas/${declaration.id}`
      );
      expect(deleted.status).toBe(204);
    }
  };

  afterEach(clearDeclarations);

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

  describe('POST /api/v1/documents', () => {
    test('stores metadata that satisfies the declaration', async () => {
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

    test('refuses metadata the declaration rejects', async () => {
      await declareReportSchema();

      const response = await createDocument({
        path: '/reports',
        metadata: { quarter: 'Q5' },
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(response.body.error.meta.path_prefix).toBe('/reports');
      expect(response.body.error.meta.resource_type).toBe('document');
      expect(response.body.error.meta.metadata_schema_id).toMatch(/^mdschema_/);
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
      await declareReportSchema();
      const inner = await declare({
        path_prefix: '/reports/legal',
        schema: {
          type: 'object',
          properties: { counsel: { type: 'string' } },
          required: ['counsel'],
        },
      });
      expect(inner.status).toBe(201);

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

    test('a deleted declaration governs nothing', async () => {
      await declareReportSchema();
      expect(
        (
          await createDocument({
            path: '/reports',
            metadata: { quarter: 'Q5' },
          })
        ).status
      ).toBe(400);

      await clearDeclarations();

      const response = await createDocument({
        path: '/reports',
        metadata: { quarter: 'Q5' },
      });
      expect(response.status).toBe(201);
    });
  });

  describe('PATCH /api/v1/documents/:document_id', () => {
    test('refuses metadata the declaration rejects', async () => {
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

    test('refuses restoring a version the declaration no longer accepts', async () => {
      const created = await createDocument({
        path: '/reports',
        metadata: { quarter: 'Q9' },
      });
      expect(created.status).toBe(201);

      // Declared after the fact: the archived version holds metadata the
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
