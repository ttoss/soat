import fs from 'node:fs';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import {
  startStubChatProvider,
  type StubChatProvider,
} from '../../fixtures/stubChatProvider';
import { storageDir } from '../../setupTests';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * An ingest names who it runs for, so the converter's generation and the
 * chunk embeddings are metered against that end user: `session_id` for a
 * session's actor, `actor_id` for an actor with no session.
 */

type UsageRow = {
  source: string | null;
  generation_id: string | null;
  document_id: string | null;
  actor_id: string | null;
  session_id: string | null;
};

describe('Document ingestion — end-user attribution', () => {
  let adminToken: string;
  let userToken: string;
  let noPermToken: string;
  let projectId: string;
  let otherProjectId: string;
  let agentId: string;
  let chat: StubChatProvider;

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  const createActor = async (project = projectId): Promise<string> => {
    const res = await asAdmin()
      .post('/api/v1/actors')
      .send({ project_id: project, name: `ingest-actor-${Math.random()}` });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const createSession = async (actorId?: string): Promise<string> => {
    const res = await asAdmin()
      .post('/api/v1/sessions')
      .send({ agent_id: agentId, ...(actorId ? { actor_id: actorId } : {}) });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const uploadImage = async (): Promise<string> => {
    const res = await asAdmin()
      .post('/api/v1/files/upload')
      .attach('file', Buffer.from(`image ${Math.random()}`), {
        filename: `scan-${Math.random()}.tiff`,
        contentType: 'image/tiff',
      })
      .field('project_id', projectId);
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const ingest = async (body: Record<string, unknown>, token = adminToken) => {
    const fileId = await uploadImage();
    return authenticatedTestClient(token)
      .post('/api/v1/documents/ingest?wait=true')
      .send({ project_id: projectId, file_id: fileId, ...body });
  };

  const usage = async (query: string): Promise<UsageRow[]> => {
    const res = await asAdmin().get(`/api/v1/usage/events?${query}&limit=100`);
    expect(res.status).toBe(200);
    return res.body.data as UsageRow[];
  };

  /** The converter's generation event and the document's chunk embeddings. */
  const meteredFor = async (args: { query: string; documentId: string }) => {
    const rows = await usage(args.query);
    return {
      converter: rows.filter((row) => {
        return row.source !== 'embedding' && row.generation_id !== null;
      }),
      embeddings: rows.filter((row) => {
        return (
          row.source === 'embedding' && row.document_id === args.documentId
        );
      }),
    };
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'ingestenduser',
      policyActions: ['documents:IngestDocument', 'files:UploadFile'],
      createOtherProject: true,
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    noPermToken = setup.noPermToken!;
    projectId = setup.projectId;
    otherProjectId = setup.otherProjectId!;

    chat = await startStubChatProvider();
    const provider = await asAdmin().post('/api/v1/ai-providers').send({
      project_id: projectId,
      name: 'ingest-end-user-chat',
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: chat.baseUrl,
    });
    expect(provider.status).toBe(201);

    const agent = await asAdmin().post('/api/v1/agents').send({
      project_id: projectId,
      ai_provider_id: provider.body.id,
      name: 'ingest-end-user-converter',
    });
    expect(agent.status).toBe(201);
    agentId = agent.body.id;

    const rule = await asAdmin().post('/api/v1/ingestion-rules').send({
      project_id: projectId,
      content_type_glob: 'image/*',
      agent_id: agentId,
      chunk_strategy: 'whole',
    });
    expect(rule.status).toBe(201);
  });

  afterAll(async () => {
    await chat.close();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  describe('POST /api/v1/documents/ingest', () => {
    test('actor_id meters the conversion and the embeddings against that actor', async () => {
      const actorId = await createActor();

      const res = await ingest({ actor_id: actorId });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('ready');
      const metered = await meteredFor({
        query: `actor_id=${actorId}`,
        documentId: res.body.id,
      });
      expect(metered.converter).toHaveLength(1);
      expect(metered.converter[0].session_id).toBeNull();
      expect(metered.embeddings.length).toBeGreaterThan(0);
    });

    test('session_id meters against the session and its actor', async () => {
      const actorId = await createActor();
      const sessionId = await createSession(actorId);

      const res = await ingest({ session_id: sessionId });

      expect(res.status).toBe(201);
      const metered = await meteredFor({
        query: `session_id=${sessionId}`,
        documentId: res.body.id,
      });
      expect(metered.converter).toHaveLength(1);
      expect(metered.converter[0].actor_id).toBe(actorId);
      expect(metered.embeddings.length).toBeGreaterThan(0);
      for (const row of metered.embeddings) {
        expect(row.actor_id).toBe(actorId);
      }
    });

    test('actor_id beside the session it belongs to is accepted', async () => {
      const actorId = await createActor();
      const sessionId = await createSession(actorId);

      const res = await ingest({ session_id: sessionId, actor_id: actorId });

      expect(res.status).toBe(201);
      const metered = await meteredFor({
        query: `session_id=${sessionId}`,
        documentId: res.body.id,
      });
      expect(metered.converter[0].actor_id).toBe(actorId);
    });

    test('actor_id contradicting the session is 400 and ingests nothing', async () => {
      const sessionId = await createSession(await createActor());
      const before = chat.completions();

      const res = await ingest({
        session_id: sessionId,
        actor_id: await createActor(),
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(chat.completions()).toBe(before);
    });

    test("another project's actor is 400 ACTOR_NOT_FOUND", async () => {
      const res = await ingest({
        actor_id: await createActor(otherProjectId),
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ACTOR_NOT_FOUND');
    });

    test('an unknown session is 400 SESSION_NOT_FOUND', async () => {
      const res = await ingest({ session_id: 'sess_doesnotexist0' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('SESSION_NOT_FOUND');
    });

    test('naming neither meters no end user', async () => {
      const res = await ingest({});

      expect(res.status).toBe(201);
      const rows = (await usage('source=embedding')).filter((row) => {
        return row.document_id === res.body.id;
      });
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.actor_id).toBeNull();
        expect(row.session_id).toBeNull();
      }
    });

    test('a caller who may ingest may name an actor', async () => {
      const res = await ingest({ actor_id: await createActor() }, userToken);

      expect(res.status).toBe(201);
    });

    test('a caller who may not ingest is 403', async () => {
      const res = await ingest({ actor_id: await createActor() }, noPermToken);

      expect(res.status).toBe(403);
    });

    test('unauthenticated is 401', async () => {
      const res = await testClient
        .post('/api/v1/documents/ingest?wait=true')
        .send({ project_id: projectId, file_id: 'file_x', actor_id: 'act_x' });

      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/v1/documents/:document_id/ingest', () => {
    test('re-ingesting with actor_id meters against that actor', async () => {
      const first = await ingest({});
      expect(first.status).toBe(201);
      const actorId = await createActor();

      const res = await asAdmin()
        .post(`/api/v1/documents/${first.body.id}/ingest?wait=true`)
        .send({ actor_id: actorId });

      expect(res.status).toBe(201);
      const metered = await meteredFor({
        query: `actor_id=${actorId}`,
        documentId: first.body.id,
      });
      expect(metered.converter).toHaveLength(1);
      expect(metered.embeddings.length).toBeGreaterThan(0);
    });

    test('re-ingesting with a contradicting pair is 400', async () => {
      const first = await ingest({});
      const sessionId = await createSession(await createActor());

      const res = await asAdmin()
        .post(`/api/v1/documents/${first.body.id}/ingest?wait=true`)
        .send({ session_id: sessionId, actor_id: await createActor() });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });
});
