import {
  createScopedPrincipal,
  setupProjectWithUsers,
} from '../../fixtures/bootstrap';
import { authenticatedTestClient, testClient } from '../../testClient';

const ACTIONS = [
  'metadata-schemas:ListMetadataSchemas',
  'metadata-schemas:CreateMetadataSchema',
  'metadata-schemas:GetMetadataSchema',
  'metadata-schemas:UpdateMetadataSchema',
  'metadata-schemas:DeleteMetadataSchema',
];

const REPORT_SCHEMA = {
  type: 'object',
  properties: { quarter: { type: 'string', enum: ['Q1', 'Q2'] } },
  required: ['quarter'],
};

/**
 * The registry: what a project declares its resources' `metadata` must
 * satisfy. A declaration is a row, so two operators governing different
 * corners of a corpus write independently.
 */
describe('Metadata schemas', () => {
  let adminToken: string;
  let userToken: string;
  let readerToken: string;
  let noPermToken: string;
  let projectId: string;
  let otherProjectId: string;
  let seq = 0;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'mdschema',
      policyActions: ACTIONS,
      createOtherProject: true,
    });

    adminToken = setup.adminToken;
    userToken = setup.userToken;
    noPermToken = setup.noPermToken as string;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId as string;

    // Reads what is declared and cannot declare: the principal the write
    // actions exist to separate from a reader.
    readerToken = await createScopedPrincipal({
      adminToken,
      projectId,
      username: 'mdschemareader',
      actions: [
        'metadata-schemas:ListMetadataSchemas',
        'metadata-schemas:GetMetadataSchema',
      ],
    });
  }, 60_000);

  /** A prefix of its own per call, so one test's declaration cannot collide
   * with another's. */
  const uniquePrefix = (): string => {
    seq += 1;
    return `/reports-${seq}`;
  };

  const declare = (body: object, token = userToken) => {
    return authenticatedTestClient(token)
      .post('/api/v1/metadata-schemas')
      .send({ project_id: projectId, ...body });
  };

  const declareReportSchema = async (pathPrefix = uniquePrefix()) => {
    const response = await declare({
      resource_type: 'document',
      path_prefix: pathPrefix,
      schema: REPORT_SCHEMA,
    });
    expect(response.status).toBe(201);
    return response.body as { id: string; path_prefix: string };
  };

  describe('POST /api/v1/metadata-schemas', () => {
    test('declares a schema for a path prefix', async () => {
      const prefix = uniquePrefix();

      const response = await declare({
        resource_type: 'document',
        path_prefix: prefix,
        schema: REPORT_SCHEMA,
      });

      expect(response.status).toBe(201);
      expect(response.body.id).toMatch(/^mdschema_/);
      expect(response.body.project_id).toBe(projectId);
      expect(response.body.resource_type).toBe('document');
      expect(response.body.path_prefix).toBe(prefix);
      expect(response.body.schema).toEqual(REPORT_SCHEMA);
    });

    test('normalizes the prefix, so one directory is one declaration', async () => {
      const prefix = uniquePrefix();

      const first = await declare({
        resource_type: 'document',
        path_prefix: `${prefix}/`,
        schema: REPORT_SCHEMA,
      });
      expect(first.status).toBe(201);
      expect(first.body.path_prefix).toBe(prefix);

      const second = await declare({
        resource_type: 'document',
        path_prefix: prefix,
        schema: { type: 'object' },
      });

      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('NAME_CONFLICT');
    });

    test('refuses a resource type no write path reads yet', async () => {
      const response = await declare({
        resource_type: 'memory',
        path_prefix: uniquePrefix(),
        schema: REPORT_SCHEMA,
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('refuses a declaration carrying no selector', async () => {
      const response = await declare({
        resource_type: 'document',
        schema: REPORT_SCHEMA,
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('refuses a prefix that names no location', async () => {
      expect(
        (
          await declare({
            resource_type: 'document',
            path_prefix: '',
            schema: REPORT_SCHEMA,
          })
        ).status
      ).toBe(400);

      // Resolves above the root.
      expect(
        (
          await declare({
            resource_type: 'document',
            path_prefix: '/..',
            schema: REPORT_SCHEMA,
          })
        ).status
      ).toBe(400);
    });

    test('refuses the reserved root', async () => {
      const response = await declare({
        resource_type: 'document',
        path_prefix: '/.system/traces',
        schema: REPORT_SCHEMA,
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('refuses a schema JSON Schema cannot compile', async () => {
      const response = await declare({
        resource_type: 'document',
        path_prefix: uniquePrefix(),
        schema: { type: 'nonsense' },
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('refuses a schema that is not an object', async () => {
      const response = await declare({
        resource_type: 'document',
        path_prefix: uniquePrefix(),
        schema: 'object',
      });

      expect(response.status).toBe(400);
    });

    test('401 without authentication', async () => {
      const response = await testClient
        .post('/api/v1/metadata-schemas')
        .send({ project_id: projectId, resource_type: 'document' });

      expect(response.status).toBe(401);
    });

    test('403 for a principal that may only read declarations', async () => {
      const response = await declare(
        {
          resource_type: 'document',
          path_prefix: uniquePrefix(),
          schema: REPORT_SCHEMA,
        },
        readerToken
      );

      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/v1/metadata-schemas', () => {
    test('lists the declarations of a project', async () => {
      const declared = await declareReportSchema();

      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/metadata-schemas?project_id=${projectId}&limit=100`
      );

      expect(response.status).toBe(200);
      const ids = (response.body.data as { id: string }[]).map((entry) => {
        return entry.id;
      });
      expect(ids).toContain(declared.id);
    });

    test('narrows to one governed resource type', async () => {
      await declareReportSchema();

      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/metadata-schemas?project_id=${projectId}&resource_type=memory`
      );

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([]);
    });

    test('a project with nothing declared lists nothing', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/metadata-schemas?project_id=${otherProjectId}`
      );

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([]);
    });

    test('401 without authentication', async () => {
      const response = await testClient.get('/api/v1/metadata-schemas');

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/v1/metadata-schemas/:metadata_schema_id', () => {
    test('returns the declaration', async () => {
      const declared = await declareReportSchema();

      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/metadata-schemas/${declared.id}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(declared.id);
      expect(response.body.schema).toEqual(REPORT_SCHEMA);
    });

    test('404 for an id that does not exist', async () => {
      const response = await authenticatedTestClient(userToken).get(
        '/api/v1/metadata-schemas/mdschema_doesnotexist'
      );

      expect(response.status).toBe(404);
    });

    test('404 for a caller the declaration is not visible to', async () => {
      const declared = await declareReportSchema();

      // "Not mine" and "does not exist" answer alike: an id a caller cannot
      // read must not be distinguishable from one that was never declared.
      const response = await authenticatedTestClient(noPermToken).get(
        `/api/v1/metadata-schemas/${declared.id}`
      );

      expect(response.status).toBe(404);
    });
  });

  describe('PATCH /api/v1/metadata-schemas/:metadata_schema_id', () => {
    test('replaces the declared schema', async () => {
      const declared = await declareReportSchema();
      const tightened = {
        type: 'object',
        properties: { quarter: { type: 'string' }, owner: { type: 'string' } },
        required: ['quarter', 'owner'],
      };

      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/metadata-schemas/${declared.id}`)
        .send({ schema: tightened });

      expect(response.status).toBe(200);
      expect(response.body.schema).toEqual(tightened);
      expect(response.body.path_prefix).toBe(declared.path_prefix);
    });

    test('moves the declaration to another prefix', async () => {
      const declared = await declareReportSchema();
      const moved = uniquePrefix();

      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/metadata-schemas/${declared.id}`)
        .send({ path_prefix: moved });

      expect(response.status).toBe(200);
      expect(response.body.path_prefix).toBe(moved);
    });

    test('refuses a prefix another declaration already governs', async () => {
      const first = await declareReportSchema();
      const second = await declareReportSchema();

      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/metadata-schemas/${second.id}`)
        .send({ path_prefix: first.path_prefix });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('NAME_CONFLICT');
    });

    test('refuses a schema JSON Schema cannot compile', async () => {
      const declared = await declareReportSchema();

      const response = await authenticatedTestClient(userToken)
        .patch(`/api/v1/metadata-schemas/${declared.id}`)
        .send({ schema: { type: 'nonsense' } });

      expect(response.status).toBe(400);
    });

    test('403 for a principal that may only read declarations', async () => {
      const declared = await declareReportSchema();

      const response = await authenticatedTestClient(readerToken)
        .patch(`/api/v1/metadata-schemas/${declared.id}`)
        .send({ schema: { type: 'object' } });

      expect(response.status).toBe(403);
    });
  });

  describe('DELETE /api/v1/metadata-schemas/:metadata_schema_id', () => {
    test('removes the declaration', async () => {
      const declared = await declareReportSchema();

      const deleted = await authenticatedTestClient(userToken).delete(
        `/api/v1/metadata-schemas/${declared.id}`
      );
      expect(deleted.status).toBe(204);

      const read = await authenticatedTestClient(userToken).get(
        `/api/v1/metadata-schemas/${declared.id}`
      );
      expect(read.status).toBe(404);
    });

    test('404 for an id that does not exist', async () => {
      const response = await authenticatedTestClient(userToken).delete(
        '/api/v1/metadata-schemas/mdschema_doesnotexist'
      );

      expect(response.status).toBe(404);
    });

    test('403 for a principal that may only read declarations', async () => {
      const declared = await declareReportSchema();

      const response = await authenticatedTestClient(readerToken).delete(
        `/api/v1/metadata-schemas/${declared.id}`
      );

      expect(response.status).toBe(403);
    });
  });

  describe('POST /api/v1/metadata-schemas/validate', () => {
    test('reports the declaration that would refuse a write', async () => {
      const declared = await declareReportSchema();

      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/metadata-schemas/validate')
        .send({
          project_id: projectId,
          path: `${declared.path_prefix}/q1.txt`,
          metadata: { quarter: 'Q9' },
        });

      expect(response.status).toBe(200);
      expect(response.body.valid).toBe(false);
      expect(response.body.metadata_schema_id).toBe(declared.id);
      expect(response.body.path_prefix).toBe(declared.path_prefix);
      expect(response.body.error).toContain('quarter');
    });

    test('reports metadata that would be accepted', async () => {
      const declared = await declareReportSchema();

      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/metadata-schemas/validate')
        .send({
          project_id: projectId,
          path: `${declared.path_prefix}/q1.txt`,
          metadata: { quarter: 'Q1' },
        });

      expect(response.status).toBe(200);
      expect(response.body.valid).toBe(true);
      expect(response.body.metadata_schema_id).toBeNull();
      expect(response.body.error).toBeNull();
    });

    test('a path nothing governs is valid', async () => {
      await declareReportSchema();

      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/metadata-schemas/validate')
        .send({
          project_id: projectId,
          path: '/ungoverned/q1.txt',
          metadata: { anything: true },
        });

      expect(response.status).toBe(200);
      expect(response.body.valid).toBe(true);
    });

    test('judges an absent bag as an empty one', async () => {
      const declared = await declareReportSchema();

      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/metadata-schemas/validate')
        .send({ project_id: projectId, path: `${declared.path_prefix}/q.txt` });

      expect(response.status).toBe(200);
      expect(response.body.valid).toBe(false);
    });

    test('401 without authentication', async () => {
      const response = await testClient
        .post('/api/v1/metadata-schemas/validate')
        .send({ project_id: projectId, path: '/reports/q1.txt' });

      expect(response.status).toBe(401);
    });

    test('403 for a caller that may read no declarations', async () => {
      const response = await authenticatedTestClient(noPermToken)
        .post('/api/v1/metadata-schemas/validate')
        .send({ project_id: projectId, path: '/reports/q1.txt' });

      expect(response.status).toBe(403);
    });
  });
});
