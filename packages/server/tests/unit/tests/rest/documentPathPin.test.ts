import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

/**
 * `?path_prefix` on a write or by-id route pins the call to one directory: a
 * document outside it is `404`, and a write that would file one outside it is
 * `400 DOCUMENT_PATH_OUTSIDE_PREFIX`. The same name filters the listing, so
 * one preset confines every document operation a tool makes.
 */
describe('Documents pinned to a path_prefix', () => {
  let userToken: string;
  let projectId: string;

  const PIN = '/people/alice/';
  const pinned = (url: string) => {
    return `${url}${url.includes('?') ? '&' : '?'}path_prefix=${encodeURIComponent(PIN)}`;
  };

  const client = () => {
    return authenticatedTestClient(userToken);
  };

  const create = async (path: string): Promise<string> => {
    const res = await client()
      .post('/api/v1/documents')
      .send({ project_id: projectId, content: `content ${path}`, path });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  const unique = () => {
    return crypto.randomUUID().slice(0, 8);
  };

  const inside = () => {
    return create(`${PIN}${unique()}.txt`);
  };

  const outside = () => {
    return create(`/people/bob/${unique()}.txt`);
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'docpin',
      policyActions: [
        'documents:CreateDocument',
        'documents:GetDocument',
        'documents:ListDocuments',
        'documents:UpdateDocument',
        'documents:DeleteDocument',
        'documents:WithdrawDocument',
        'documents:ListDocumentVersions',
        'documents:GetDocumentVersion',
        'documents:RestoreDocumentVersion',
        'documents:IngestDocument',
        'files:UploadFile',
        'files:GetFile',
      ],
    });
    userToken = setup.userToken;
    projectId = setup.projectId;
  });

  const byIdRoutes: Array<{
    name: string;
    call: (
      id: string,
      url: (u: string) => string
    ) => Promise<{ status: number }>;
  }> = [
    {
      name: 'GET /documents/{id}',
      call: (id, url) => {
        return client().get(url(`/api/v1/documents/${id}`));
      },
    },
    {
      name: 'PATCH /documents/{id}',
      call: (id, url) => {
        return client()
          .patch(url(`/api/v1/documents/${id}`))
          .send({ title: 'renamed' });
      },
    },
    {
      name: 'DELETE /documents/{id}',
      call: (id, url) => {
        return client().delete(url(`/api/v1/documents/${id}`));
      },
    },
    {
      name: 'POST /documents/{id}/withdraw',
      call: (id, url) => {
        return client()
          .post(url(`/api/v1/documents/${id}/withdraw`))
          .send({});
      },
    },
    {
      name: 'GET /documents/{id}/versions',
      call: (id, url) => {
        return client().get(url(`/api/v1/documents/${id}/versions`));
      },
    },
    {
      name: 'GET /documents/{id}/versions/{version}',
      call: (id, url) => {
        return client().get(url(`/api/v1/documents/${id}/versions/1`));
      },
    },
    {
      name: 'POST /documents/{id}/versions/{version}/restore',
      call: (id, url) => {
        return client()
          .post(url(`/api/v1/documents/${id}/versions/1/restore`))
          .send({});
      },
    },
    {
      name: 'GET /documents/{id}/status',
      call: (id, url) => {
        return client().get(url(`/api/v1/documents/${id}/status`));
      },
    },
    {
      name: 'GET /documents/{id}/tags',
      call: (id, url) => {
        return client().get(url(`/api/v1/documents/${id}/tags`));
      },
    },
    {
      name: 'PUT /documents/{id}/tags',
      call: (id, url) => {
        return client()
          .put(url(`/api/v1/documents/${id}/tags`))
          .send({ owner: 'alice' });
      },
    },
    {
      name: 'GET /documents/{id}/relations',
      call: (id, url) => {
        return client().get(url(`/api/v1/documents/${id}/relations`));
      },
    },
  ];

  describe.each(byIdRoutes)('$name', ({ call }) => {
    test('reaches a document inside the pin', async () => {
      const res = await call(await inside(), pinned);
      expect(res.status).toBeLessThan(300);
    });

    test('answers 404 for a document outside the pin', async () => {
      const res = await call(await outside(), pinned);
      expect(res.status).toBe(404);
    });

    test('reaches any document without a pin', async () => {
      const res = await call(await outside(), (u) => {
        return u;
      });
      expect(res.status).toBeLessThan(300);
    });
  });

  test('POST /documents/{id}/ingest answers 404 outside the pin', async () => {
    const res = await client()
      .post(pinned(`/api/v1/documents/${await outside()}/ingest`))
      .send({});
    expect(res.status).toBe(404);
  });

  describe('relations', () => {
    test('a target outside the pin is 404', async () => {
      const res = await client()
        .post(pinned(`/api/v1/documents/${await inside()}/relations`))
        .send({ type: 'cites', to_document_id: await outside() });
      expect(res.status).toBe(404);
    });

    test('a target inside the pin is related', async () => {
      const res = await client()
        .post(pinned(`/api/v1/documents/${await inside()}/relations`))
        .send({ type: 'cites', to_document_id: await inside() });
      expect(res.status).toBe(201);
    });

    test('deleting an edge of a document outside the pin is 404', async () => {
      const from = await outside();
      const edge = await client()
        .post(`/api/v1/documents/${from}/relations`)
        .send({ type: 'cites', to_document_id: await outside() });
      expect(edge.status).toBe(201);

      const res = await client().delete(
        pinned(`/api/v1/documents/${from}/relations/${edge.body.id}`)
      );
      expect(res.status).toBe(404);
    });
  });

  describe('POST /documents', () => {
    const createPinned = (body: Record<string, unknown>) => {
      return client()
        .post(pinned('/api/v1/documents'))
        .send({ project_id: projectId, content: 'pinned', ...body });
    };

    test('creates inside the pin', async () => {
      const res = await createPinned({ path: `${PIN}${unique()}.txt` });
      expect(res.status).toBe(201);
    });

    test('refuses a path outside the pin', async () => {
      const res = await createPinned({ path: `/people/bob/${unique()}.txt` });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('DOCUMENT_PATH_OUTSIDE_PREFIX');
    });

    test('refuses a sibling sharing the prefix as a string', async () => {
      const res = await createPinned({
        path: `/people/alice2/${unique()}.txt`,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('DOCUMENT_PATH_OUTSIDE_PREFIX');
    });

    test('refuses a `..` segment before the pin is read', async () => {
      const res = await createPinned({
        path: `${PIN}../bob/${unique()}.txt`,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('refuses a create without a path, whose default falls outside', async () => {
      const res = await createPinned({});
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('DOCUMENT_PATH_OUTSIDE_PREFIX');
    });

    test('refuses a create named only by filename', async () => {
      const res = await createPinned({ filename: `${unique()}.txt` });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('DOCUMENT_PATH_OUTSIDE_PREFIX');
    });

    test('a refused create writes nothing', async () => {
      const path = `/people/bob/${unique()}.txt`;
      await createPinned({ path });

      const res = await client().get(
        `/api/v1/documents?project_id=${projectId}&path_prefix=/people/bob/&limit=100`
      );
      expect(
        (res.body.data as Array<{ path: string }>).map((doc) => {
          return doc.path;
        })
      ).not.toContain(path);
    });
  });

  describe('PATCH moving path', () => {
    test('moves within the pin', async () => {
      const res = await client()
        .patch(pinned(`/api/v1/documents/${await inside()}`))
        .send({ path: `${PIN}moved-${unique()}.txt` });
      expect(res.status).toBe(200);
    });

    test('refuses a move outside the pin', async () => {
      const id = await inside();
      const res = await client()
        .patch(pinned(`/api/v1/documents/${id}`))
        .send({ path: `/people/bob/${unique()}.txt` });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('DOCUMENT_PATH_OUTSIDE_PREFIX');

      const after = await client().get(`/api/v1/documents/${id}`);
      expect(after.body.path.startsWith(PIN)).toBe(true);
    });

    test('refuses clearing the path', async () => {
      const res = await client()
        .patch(pinned(`/api/v1/documents/${await inside()}`))
        .send({ path: null });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('DOCUMENT_PATH_OUTSIDE_PREFIX');
    });
  });

  describe('POST /documents/ingest', () => {
    const upload = async (filename: string): Promise<string> => {
      const res = await client()
        .post('/api/v1/files/upload')
        .attach('file', Buffer.from(`ingest ${unique()}`), {
          filename,
          contentType: 'text/plain',
        })
        .field('project_id', projectId);
      expect(res.status).toBe(201);
      return res.body.id as string;
    };

    const ingest = async (args: { filename: string; pathPrefix: string }) => {
      return client()
        .post('/api/v1/documents/ingest?wait=true')
        .send({
          project_id: projectId,
          file_id: await upload(args.filename),
          path_prefix: args.pathPrefix,
        });
    };

    test('files under the body path_prefix', async () => {
      const res = await ingest({
        filename: `${unique()}.txt`,
        pathPrefix: PIN,
      });
      expect(res.status).toBe(201);
      expect(res.body.path.startsWith(PIN)).toBe(true);
    });
  });

  describe('the pin itself', () => {
    test('a prefix without a trailing / names the same directory', async () => {
      const res = await client().get(
        `/api/v1/documents/${await inside()}?path_prefix=/people/alice`
      );
      expect(res.status).toBe(200);
    });

    test('a prefix is a path boundary, not a substring', async () => {
      const sibling = await create(`/people/alice2/${unique()}.txt`);
      const res = await client().get(
        `/api/v1/documents/${sibling}?path_prefix=/people/alice`
      );
      expect(res.status).toBe(404);
    });

    test('a repeated prefix is refused rather than dropped', async () => {
      const res = await client().get(
        `/api/v1/documents/${await outside()}?path_prefix=${PIN}&path_prefix=/people/bob/`
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('the root pin reaches every document', async () => {
      const res = await client().get(
        `/api/v1/documents/${await outside()}?path_prefix=/`
      );
      expect(res.status).toBe(200);
    });
  });
});
