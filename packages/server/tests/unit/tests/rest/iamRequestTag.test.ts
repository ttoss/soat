import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient, loginAs } from '../../testClient';

/**
 * `iam:RequestTag/<key>` is the value a request writes for a tag key, so a
 * policy can reserve a key to one principal: here a Deny keeps every principal
 * but the screener from writing `screened: clean`, while other tag writes pass.
 * Every route that writes caller tags must supply it, or the Deny silently
 * stops denying there — so each one is a row below.
 */
const VERDICT = { screened: 'clean' };
const LABEL = { team: 'ops' };

const DENY_VERDICT = {
  effect: 'Deny',
  action: ['*'],
  condition: { StringEquals: { 'iam:RequestTag/screened': 'clean' } },
};

describe('iam:RequestTag', () => {
  let adminToken: string;
  let screenerToken: string;
  let writerToken: string;
  let projectId: string;
  const ids: Record<string, string> = {};

  const as = (token: string) => {
    return authenticatedTestClient(token);
  };

  const createPrincipal = async (args: {
    username: string;
    statement: object[];
  }) => {
    const user = await as(adminToken)
      .post('/api/v1/users')
      .send({ username: args.username, password: `${args.username}pass` });
    const policy = await as(adminToken)
      .post('/api/v1/policies')
      .send({ document: { statement: args.statement } });
    expect(policy.status).toBe(201);
    await as(adminToken)
      .put(`/api/v1/users/${user.body.id}/policies`)
      .send({ policy_ids: [policy.body.id] });
    return loginAs(args.username, `${args.username}pass`);
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'reqtag',
      policyActions: ['*'],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    screenerToken = setup.userToken;
    projectId = setup.projectId;
    writerToken = await createPrincipal({
      username: 'reqtagwriter',
      statement: [{ effect: 'Allow', action: ['*'] }, DENY_VERDICT],
    });

    const provider = await as(adminToken).post('/api/v1/ai-providers').send({
      project_id: projectId,
      name: 'RequestTag Provider',
      provider: 'ollama',
      default_model: 'llama3.2',
    });
    const agent = await as(screenerToken).post('/api/v1/agents').send({
      project_id: projectId,
      name: 'RequestTag Agent',
      ai_provider_id: provider.body.id,
    });
    ids.agent = agent.body.id;

    const created = await Promise.all([
      as(screenerToken)
        .post('/api/v1/sessions')
        .send({ agent_id: ids.agent, name: 'rt' }),
      as(screenerToken)
        .post('/api/v1/documents')
        .send({ project_id: projectId, content: 'doc', path: '/rt/doc.md' }),
      as(screenerToken)
        .post('/api/v1/memory-stores')
        .send({ project_id: projectId, name: 'rt store' }),
      as(screenerToken)
        .post('/api/v1/actors')
        .send({ project_id: projectId, name: 'rt actor' }),
      as(screenerToken)
        .post('/api/v1/conversations')
        .send({ project_id: projectId }),
      as(screenerToken)
        .post('/api/v1/files/upload')
        .attach('file', Buffer.from('file'), {
          filename: 'rt.txt',
          contentType: 'text/plain',
        })
        .field('project_id', projectId),
      as(screenerToken)
        .post('/api/v1/collections')
        .send({ project_id: projectId, name: 'rt' }),
    ]);
    [
      ids.session,
      ids.document,
      ids.store,
      ids.actor,
      ids.conversation,
      ids.file,
      ids.collection,
    ] = created.map((response) => {
      expect(response.status).toBeLessThan(300);
      return response.body.id as string;
    });

    const memory = await as(screenerToken)
      .post('/api/v1/memories')
      .send({ memory_store_id: ids.store, content: 'rt memory' });
    ids.memory = memory.body.id;
    const item = await as(screenerToken)
      .put(`/api/v1/collections/${ids.collection}/items/k1`)
      .send({ data: { n: 1 } });
    expect(item.status).toBeLessThan(300);
  }, 120_000);

  const unique = () => {
    return crypto.randomUUID();
  };

  const WRITES: Array<{
    name: string;
    write: (
      token: string,
      tags: Record<string, string>
    ) => PromiseLike<{ status: number }>;
  }> = [
    {
      name: 'POST /documents',
      write: (token, tags) => {
        return as(token)
          .post('/api/v1/documents')
          .send({
            project_id: projectId,
            content: 'x',
            path: `/rt/${unique()}.md`,
            tags,
          });
      },
    },
    {
      name: 'PATCH /documents/:id',
      write: (token, tags) => {
        return as(token)
          .patch(`/api/v1/documents/${ids.document}`)
          .send({ tags });
      },
    },
    {
      name: 'PATCH /documents/:id/tags',
      write: (token, tags) => {
        return as(token)
          .patch(`/api/v1/documents/${ids.document}/tags`)
          .send(tags);
      },
    },
    {
      name: 'POST /documents/ingest',
      // A file backs one document, so every ingest uploads its own.
      write: async (token, tags) => {
        const file = await as(screenerToken)
          .post('/api/v1/files/upload')
          .attach('file', Buffer.from(unique()), {
            filename: `${unique()}.txt`,
            contentType: 'text/plain',
          })
          .field('project_id', projectId);
        return as(token)
          .post('/api/v1/documents/ingest?wait=true')
          .send({
            project_id: projectId,
            file_id: file.body.id,
            path_prefix: `/rt/${unique()}/`,
            tags,
          });
      },
    },
    {
      name: 'POST /memories',
      write: (token, tags) => {
        return as(token)
          .post('/api/v1/memories')
          .send({ memory_store_id: ids.store, content: unique(), tags });
      },
    },
    {
      name: 'PUT /memories/:id',
      write: (token, tags) => {
        return as(token).put(`/api/v1/memories/${ids.memory}`).send({ tags });
      },
    },
    {
      name: 'PATCH /memories/:id/tags',
      write: (token, tags) => {
        return as(token)
          .patch(`/api/v1/memories/${ids.memory}/tags`)
          .send(tags);
      },
    },
    {
      name: 'POST /memory-stores',
      write: (token, tags) => {
        return as(token)
          .post('/api/v1/memory-stores')
          .send({ project_id: projectId, name: unique(), tags });
      },
    },
    {
      name: 'PUT /memory-stores/:id',
      write: (token, tags) => {
        return as(token)
          .put(`/api/v1/memory-stores/${ids.store}`)
          .send({ tags });
      },
    },
    {
      name: 'PATCH /memory-stores/:id/tags',
      write: (token, tags) => {
        return as(token)
          .patch(`/api/v1/memory-stores/${ids.store}/tags`)
          .send(tags);
      },
    },
    {
      name: 'PATCH /actors/:id',
      write: (token, tags) => {
        return as(token).patch(`/api/v1/actors/${ids.actor}`).send({ tags });
      },
    },
    {
      name: 'PATCH /actors/:id/tags',
      write: (token, tags) => {
        return as(token).patch(`/api/v1/actors/${ids.actor}/tags`).send(tags);
      },
    },
    {
      name: 'POST /sessions',
      write: (token, tags) => {
        return as(token)
          .post('/api/v1/sessions')
          .send({ agent_id: ids.agent, name: unique(), tags });
      },
    },
    {
      name: 'POST /sessions/:id/fork',
      write: (token, tags) => {
        return as(token)
          .post(`/api/v1/sessions/${ids.session}/fork`)
          .send({ tags });
      },
    },
    {
      name: 'PATCH /sessions/:id/tags',
      write: (token, tags) => {
        return as(token)
          .patch(`/api/v1/sessions/${ids.session}/tags`)
          .send(tags);
      },
    },
    {
      name: 'PATCH /conversations/:id/tags',
      write: (token, tags) => {
        return as(token)
          .patch(`/api/v1/conversations/${ids.conversation}/tags`)
          .send(tags);
      },
    },
    {
      name: 'PATCH /files/:id/tags',
      write: (token, tags) => {
        return as(token).patch(`/api/v1/files/${ids.file}/tags`).send(tags);
      },
    },
    {
      name: 'PUT /collections/:id/items/:key',
      write: (token, tags) => {
        return as(token)
          .put(`/api/v1/collections/${ids.collection}/items/${unique()}`)
          .send({ data: { n: 1 }, tags });
      },
    },
    {
      name: 'PATCH /collections/:id/items/:key',
      write: (token, tags) => {
        return as(token)
          .patch(`/api/v1/collections/${ids.collection}/items/k1`)
          .send({ tags });
      },
    },
    {
      name: 'PATCH /collections/:id/items/:key/tags',
      write: (token, tags) => {
        return as(token)
          .patch(`/api/v1/collections/${ids.collection}/items/k1/tags`)
          .send(tags);
      },
    },
  ];

  describe.each(WRITES)('$name', ({ write }) => {
    test('a write setting the reserved key is refused', async () => {
      const response = await write(writerToken, VERDICT);
      expect(response.status).toBe(403);
    });

    test('a write setting other keys passes', async () => {
      const response = await write(writerToken, LABEL);
      expect(response.status).toBeLessThan(300);
    });

    test('the principal the key is reserved to may set it', async () => {
      const response = await write(screenerToken, VERDICT);
      expect(response.status).toBeLessThan(300);
    });
  });

  describe('POST /api/v1/formations', () => {
    const deploy = (args: {
      token: string;
      tags: Record<string, unknown>;
      parameters?: Record<string, string>;
    }) => {
      return as(args.token)
        .post('/api/v1/formations')
        .send({
          project_id: projectId,
          name: `rt-${unique()}`,
          template: {
            parameters: { Verdict: { type: 'string' } },
            resources: {
              Doc: {
                type: 'document',
                properties: {
                  path: `/rt/${unique()}.md`,
                  content: 'x',
                  tags: args.tags,
                },
              },
            },
          },
          parameters: args.parameters ?? { Verdict: 'clean' },
        });
    };

    test('a resource setting the reserved key is refused', async () => {
      const response = await deploy({ token: writerToken, tags: VERDICT });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    test('a resource setting other keys deploys', async () => {
      const response = await deploy({ token: writerToken, tags: LABEL });
      expect(response.status).toBe(201);
    });

    test('a computed value for a key a RequestTag condition names is refused', async () => {
      const response = await deploy({
        token: writerToken,
        tags: { screened: { param: 'Verdict' } },
      });
      expect(response.status).toBe(403);
    });

    test('a computed value is fine where no policy names the key', async () => {
      const response = await deploy({
        token: screenerToken,
        tags: { screened: { param: 'Verdict' } },
      });
      expect(response.status).toBe(201);
    });
  });

  describe('POST /api/v1/policies', () => {
    test('accepts an iam:RequestTag/<key> condition', async () => {
      const response = await as(adminToken)
        .post('/api/v1/policies')
        .send({ document: { statement: [DENY_VERDICT] } });
      expect(response.status).toBe(201);
    });

    test('refuses an iam:RequestTag/ key with no tag', async () => {
      const response = await as(adminToken)
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [
              {
                effect: 'Deny',
                action: ['*'],
                condition: { StringEquals: { 'iam:RequestTag/': 'clean' } },
              },
            ],
          },
        });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('reads', () => {
    test('a Deny conditioned on a request tag does not apply to a read', async () => {
      // A read writes no tag, so the condition reads an absent key: a list is
      // filtered as if the statement were not there.
      const listerToken = await createPrincipal({
        username: 'reqtaglister',
        statement: [
          { effect: 'Allow', action: ['documents:ListDocuments'] },
          {
            effect: 'Deny',
            action: ['documents:ListDocuments'],
            condition: { StringEquals: { 'iam:RequestTag/screened': 'clean' } },
          },
        ],
      });
      const response = await as(listerToken).get(
        `/api/v1/documents?project_id=${projectId}`
      );
      expect(response.status).toBe(200);
      expect(response.body.data.length).toBeGreaterThan(0);
    });
  });
});
