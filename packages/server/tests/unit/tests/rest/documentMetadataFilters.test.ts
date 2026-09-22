import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

const ACTIONS = [
  'documents:CreateDocument',
  'documents:ListDocuments',
  'metadata-schemas:CreateMetadataSchema',
];

/**
 * The filter: what a caller can ask of the bag, and what it is told when the
 * question has no answer.
 */
describe('Document metadata filters', () => {
  let userToken: string;
  let projectId: string;
  let otherProjectId: string;
  /** Allowed the same actions everywhere but `/notes`. */
  let scopedToken: string;

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'docmetafilter',
      policyActions: ACTIONS,
      createOtherProject: true,
    });

    userToken = setup.userToken;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId!;

    const scopedUser = await authenticatedTestClient(setup.adminToken)
      .post('/api/v1/users')
      .send({ username: 'docmetafilterscoped', password: 'scopedpass' });
    const scopedPolicy = await authenticatedTestClient(setup.adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            { effect: 'Allow', action: ACTIONS },
            {
              effect: 'Deny',
              action: ['documents:ListDocuments'],
              resource: [`srn:${setup.projectId}:document:/notes/*`],
            },
          ],
        },
      });
    await authenticatedTestClient(setup.adminToken)
      .put(`/api/v1/users/${scopedUser.body.id}/policies`)
      .send({ policy_ids: [scopedPolicy.body.id] });
    scopedToken = await loginAs('docmetafilterscoped', 'scopedpass');

    const declared = await authenticatedTestClient(userToken)
      .post('/api/v1/metadata-schemas')
      .send({
        project_id: projectId,
        resource_type: 'document',
        path_prefix: '/reports',
        schema: {
          type: 'object',
          properties: {
            quarter: { type: 'string' },
            revision: { type: 'integer' },
            approved: { type: 'boolean' },
          },
        },
      });
    expect(declared.status).toBe(201);

    const create = async (args: { path: string; metadata: unknown }) => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents')
        .send({
          project_id: projectId,
          content: 'Revenue is up.',
          filename: args.path.split('/').pop(),
          path: args.path,
          metadata: args.metadata,
        });
      expect(response.status).toBe(201);
    };

    await create({
      path: '/reports/q1.txt',
      metadata: { quarter: 'Q1', revision: 2, approved: true },
    });
    await create({
      path: '/reports/q2.txt',
      metadata: { quarter: 'Q2', revision: 11, approved: false },
    });
    await create({
      path: '/reports/q3.txt',
      metadata: { quarter: 'Q3', revision: 7 },
    });
    // Ungoverned, and carrying `revision` as a string: a numeric range must
    // leave it out rather than fail on it.
    await create({
      path: '/notes/draft.txt',
      metadata: { quarter: 'Q1', revision: 'n/a' },
    });

    /** A project that declares nothing, so nothing here is typed by a schema. */
    const createUngoverned = async (args: {
      path: string;
      metadata: unknown;
    }) => {
      const response = await authenticatedTestClient(userToken)
        .post('/api/v1/documents')
        .send({
          project_id: otherProjectId,
          content: 'Held steady.',
          filename: args.path.split('/').pop(),
          path: args.path,
          metadata: args.metadata,
        });
      expect(response.status).toBe(201);
    };

    await createUngoverned({
      path: '/data/a.txt',
      metadata: { revision: 2 },
    });
    await createUngoverned({
      path: '/data/b.txt',
      metadata: { revision: 7 },
    });
    await createUngoverned({
      path: '/data/c.txt',
      metadata: { revision: 11 },
    });
    await createUngoverned({
      path: '/typed/number.txt',
      metadata: { revision: 3 },
    });
    await createUngoverned({
      path: '/typed/string.txt',
      metadata: { revision: '3' },
    });
  }, 90_000);

  const list = (metadata: unknown, query = '') => {
    const filter = encodeURIComponent(JSON.stringify(metadata));
    return authenticatedTestClient(userToken).get(
      `/api/v1/documents?project_id=${projectId}&metadata=${filter}${query}`
    );
  };

  const listUngoverned = (metadata: unknown, query = '') => {
    const filter = encodeURIComponent(JSON.stringify(metadata));
    return authenticatedTestClient(userToken).get(
      `/api/v1/documents?project_id=${otherProjectId}&metadata=${filter}${query}`
    );
  };

  const pathsOf = (body: { data: { path?: string }[] }) => {
    return body.data
      .map((doc) => {
        return doc.path;
      })
      .sort();
  };

  describe('equality', () => {
    test('matches documents whose bag contains the pair', async () => {
      const response = await list({ quarter: 'Q1' });

      expect(response.status).toBe(200);
      expect(pathsOf(response.body)).toEqual([
        '/notes/draft.txt',
        '/reports/q1.txt',
      ]);
    });

    test('several pairs must all be present', async () => {
      const response = await list({ quarter: 'Q1', revision: 2 });

      expect(response.status).toBe(200);
      expect(pathsOf(response.body)).toEqual(['/reports/q1.txt']);
    });

    test('a number and its string spelling are different values', async () => {
      const response = await list({ revision: '2' });

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([]);
    });

    test('matches a boolean', async () => {
      const response = await list({ approved: false });

      expect(response.status).toBe(200);
      expect(pathsOf(response.body)).toEqual(['/reports/q2.txt']);
    });

    test('needs no declaration', async () => {
      const response = await list({ quarter: 'Q1' }, '');

      expect(response.status).toBe(200);
      expect(pathsOf(response.body)).toContain('/notes/draft.txt');
    });
  });

  describe('in', () => {
    test('matches any of the listed values', async () => {
      const response = await list({ quarter: { in: ['Q2', 'Q3'] } });

      expect(response.status).toBe(200);
      expect(pathsOf(response.body)).toEqual([
        '/reports/q2.txt',
        '/reports/q3.txt',
      ]);
    });

    test('refuses an empty list', async () => {
      const response = await list({ quarter: { in: [] } });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('refuses a non-array', async () => {
      const response = await list({ quarter: { in: 'Q2' } });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('range', () => {
    test('compares a number numerically, not as text', async () => {
      const response = await list({ revision: { gte: 7 } });

      expect(response.status).toBe(200);
      // Text ordering would drop `11`, which sorts before `7`.
      expect(pathsOf(response.body)).toEqual([
        '/reports/q2.txt',
        '/reports/q3.txt',
      ]);
    });

    test('bounds combine', async () => {
      const response = await list({ revision: { gte: 3, lt: 11 } });

      expect(response.status).toBe(200);
      expect(pathsOf(response.body)).toEqual(['/reports/q3.txt']);
    });

    test('leaves out a document whose value is another type', async () => {
      const response = await list({ revision: { lt: 5 } });

      expect(response.status).toBe(200);
      // `/notes/draft.txt` holds the string `n/a`, which is not below 5 — and
      // asking must not fail on it.
      expect(pathsOf(response.body)).toEqual(['/reports/q1.txt']);
    });

    test('compares a string', async () => {
      const response = await list({ quarter: { gt: 'Q2' } });

      expect(response.status).toBe(200);
      expect(pathsOf(response.body)).toEqual(['/reports/q3.txt']);
    });

    test('orders an undeclared number numerically', async () => {
      const response = await listUngoverned({ revision: { gte: 7 } });

      expect(response.status).toBe(200);
      // The project declares nothing, so the operand alone says what the
      // comparison is.
      expect(pathsOf(response.body)).toEqual(['/data/b.txt', '/data/c.txt']);
    });

    test('orders across projects for a JWT caller', async () => {
      const filter = encodeURIComponent(
        JSON.stringify({ revision: { gte: 11 } })
      );
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/documents?metadata=${filter}&limit=100`
      );

      expect(response.status).toBe(200);
      expect(pathsOf(response.body)).toEqual([
        '/data/c.txt',
        '/reports/q2.txt',
      ]);
    });

    test('an operand of one type never matches a row holding another', async () => {
      const numeric = await listUngoverned(
        { revision: { gte: 1 } },
        '&path_prefix=/typed'
      );
      expect(numeric.status).toBe(200);
      expect(pathsOf(numeric.body)).toEqual(['/typed/number.txt']);

      const textual = await listUngoverned(
        { revision: { gte: '1' } },
        '&path_prefix=/typed'
      );
      expect(textual.status).toBe(200);
      expect(pathsOf(textual.body)).toEqual(['/typed/string.txt']);
    });

    test('refuses a non-orderable operand', async () => {
      for (const operand of [true, null, [1], {}]) {
        const response = await list({ flag: { gt: operand } });

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_FAILED');
        expect(response.body.error.meta.field).toBe('flag');
      }
    });
  });

  describe('malformed filters', () => {
    test('refuses a filter that is not JSON', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/documents?project_id=${projectId}&metadata=not-json`
      );

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('refuses a filter that is not an object', async () => {
      const response = await list(['quarter']);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('refuses an unknown operator', async () => {
      const response = await list({ quarter: { like: 'Q%' } });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(response.body.error.meta.field).toBe('quarter');
    });

    test('refuses an operator object that names no operator', async () => {
      const response = await list({ quarter: {} });

      expect(response.status).toBe(400);
      expect(response.body.error.meta.field).toBe('quarter');
    });

    test('refuses in combined with an ordering', async () => {
      const response = await list({ revision: { in: [2], gte: 2 } });

      expect(response.status).toBe(400);
      expect(response.body.error.meta.field).toBe('revision');
    });

    test('refuses the filter sent twice', async () => {
      const response = await authenticatedTestClient(userToken).get(
        `/api/v1/documents?project_id=${projectId}&metadata=%7B%7D&metadata=%7B%7D`
      );

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('refuses an array value', async () => {
      const response = await list({ quarter: ['Q1', 'Q2'] });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('an empty filter narrows nothing', async () => {
      const response = await list({});

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBe(4);
    });
  });

  test('narrows within what the caller may see, never instead of it', async () => {
    const filter = encodeURIComponent(JSON.stringify({ quarter: 'Q1' }));
    const response = await authenticatedTestClient(scopedToken).get(
      `/api/v1/documents?project_id=${projectId}&metadata=${filter}`
    );

    expect(response.status).toBe(200);
    // The unscoped caller sees `/notes/draft.txt` for this filter; this one's
    // policy denies that path, and the filter is ANDed onto the policy's own
    // predicate rather than written over it.
    expect(pathsOf(response.body)).toEqual(['/reports/q1.txt']);
  });

  test('requires authentication', async () => {
    const response = await testClient.get(
      `/api/v1/documents?project_id=${projectId}&metadata=%7B%7D`
    );

    expect(response.status).toBe(401);
  });
});
