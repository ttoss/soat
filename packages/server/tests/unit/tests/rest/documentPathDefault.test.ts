import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * A document with no path is reachable only by its id: every prefix read is a
 * `LIKE`, and `LIKE` never matches null. A document created from inline content
 * with no name of its own is therefore keyed by its own id, so listing `/`
 * really is the whole project.
 */
describe('the path a document gets when it is not given one', () => {
  let userToken: string;
  let projectId: string;

  const client = () => {
    return authenticatedTestClient(userToken);
  };

  const create = async (body: Record<string, unknown>) => {
    const res = await client()
      .post('/api/v1/documents')
      .send({ project_id: projectId, content: 'inline content', ...body });
    expect(res.status).toBe(201);
    return res.body as { id: string; path: string | null; filename: string };
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'docpath',
      policyActions: [
        'documents:CreateDocument',
        'documents:GetDocument',
        'documents:ListDocuments',
        'documents:UpdateDocument',
      ],
    });
    userToken = setup.userToken;
    projectId = setup.projectId;
  });

  test('a document named by neither path nor filename is keyed by its id', async () => {
    const doc = await create({});

    expect(doc.path).toBe(`/${doc.id}.txt`);
  });

  test('its filename matches the key, so the two do not disagree', async () => {
    const doc = await create({});

    expect(doc.filename).toBe(`${doc.id}.txt`);
  });

  test('two nameless documents do not collide on the unique key', async () => {
    const first = await create({});
    const second = await create({});

    expect(first.path).not.toBe(second.path);
  });

  test('a filename still names the path, as before', async () => {
    const doc = await create({ filename: 'report.txt' });

    expect(doc.path).toBe('/report.txt');
    expect(doc.filename).toBe('report.txt');
  });

  test('an explicit path still wins over a filename', async () => {
    const doc = await create({ path: '/reports/q1.txt', filename: 'other.txt' });

    expect(doc.path).toBe('/reports/q1.txt');
  });

  test('listing the whole project now returns it', async () => {
    const doc = await create({});

    const res = await client().get(
      `/api/v1/documents?project_id=${projectId}&path_prefix=/&limit=100`
    );

    expect(res.status).toBe(200);
    expect(
      (res.body.data as Array<{ id: string }>).map((d) => {
        return d.id;
      })
    ).toContain(doc.id);
  });

  test('a caller may still clear the path, and keeps a document by id', async () => {
    // An explicit clear is a caller's choice, not the default this fixes.
    const doc = await create({});
    const cleared = await client()
      .patch(`/api/v1/documents/${doc.id}`)
      .send({ path: null });

    expect(cleared.status).toBe(200);
    expect(cleared.body.path ?? null).toBeNull();

    const read = await client().get(`/api/v1/documents/${doc.id}`);
    expect(read.status).toBe(200);
  });
});
