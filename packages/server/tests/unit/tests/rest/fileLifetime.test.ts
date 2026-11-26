import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { pollUntil } from '../../fixtures/poll';
import { authenticatedTestClient, testClient } from '../../testClient';

/**
 * A file's lifetime: `expires_at` (after which every read answers `404` and a
 * sweep deletes it) and `delete_after: "generation"` (single use: claimed by
 * the generation that reads it, deleted when that generation settles). Such a
 * file never becomes a document and never enters a conversation turn.
 *
 * Driven against a local OpenAI-compatible stub that can hold its answer, so
 * a generation can be observed while it is still running.
 */

const BYTES = Buffer.from('exam-results-read-once');
const HOUR_MS = 60 * 60 * 1000;

type HeldStub = {
  baseUrl: string;
  requests: () => string[];
  /** The next answer waits until `release` is called. */
  hold: () => void;
  release: () => void;
  /** The next answer is a provider error. */
  failNext: () => void;
  close: () => Promise<void>;
};

const startHeldStub = async (): Promise<HeldStub> => {
  const requests: string[] = [];
  let held: Array<() => void> | null = null;
  let failNext = false;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      requests.push(Buffer.concat(chunks).toString('utf8'));
      const answer = () => {
        if (failNext) {
          failNext = false;
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: { message: 'refused', type: 'invalid_request_error' },
            })
          );
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-lifetime',
            object: 'chat.completion',
            created: 0,
            model: 'stub-model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'read' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
          })
        );
      };
      if (held) {
        held.push(answer);
        return;
      }
      answer();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests: () => {
      return [...requests];
    },
    hold: () => {
      held = [];
    },
    release: () => {
      const waiting = held ?? [];
      held = null;
      for (const answer of waiting) answer();
    },
    failNext: () => {
      failNext = true;
    },
    close: () => {
      return new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
};

describe('file lifetime', () => {
  let adminToken: string;
  let userToken: string;
  let noPermToken: string;
  let projectId: string;
  let agentId: string;
  let stub: HeldStub;

  const uploadBase64 = async (body: Record<string, unknown>) => {
    return authenticatedTestClient(adminToken)
      .post('/api/v1/files/upload/base64')
      .send({
        project_id: projectId,
        content: BYTES.toString('base64'),
        content_type: 'application/pdf',
        ...body,
      });
  };

  const uploadSingleUse = async (filename: string): Promise<string> => {
    const res = await uploadBase64({ filename, delete_after: 'generation' });
    expect(res.status).toBe(201);
    return res.body.id;
  };

  const getFile = (fileId: string) => {
    return authenticatedTestClient(adminToken).get(`/api/v1/files/${fileId}`);
  };

  const fileMessage = (fileId: string) => {
    return [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Fill the case sheet from the exam.' },
          { type: 'file', file_id: fileId },
        ],
      },
    ];
  };

  beforeAll(async () => {
    stub = await startHeldStub();
    const setup = await setupProjectWithUsers({
      prefix: 'filelifetime',
      policyActions: [
        'files:UploadFile',
        'files:GetFile',
        'files:DownloadFile',
        'files:UpdateFileMetadata',
      ],
    });
    adminToken = setup.adminToken;
    userToken = setup.userToken;
    noPermToken = setup.noPermToken!;
    projectId = setup.projectId;

    const provider = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'lifetime-provider',
        provider: 'ollama',
        default_model: 'stub-model',
        base_url: stub.baseUrl,
      });
    expect(provider.status).toBe(201);
    const agent = await authenticatedTestClient(adminToken)
      .post('/api/v1/agents')
      .send({
        project_id: projectId,
        name: 'lifetime-agent',
        ai_provider_id: provider.body.id,
      });
    expect(agent.status).toBe(201);
    agentId = agent.body.id;
  });

  afterAll(async () => {
    stub.release();
    await stub.close();
  });

  describe('POST /api/v1/files/upload/base64', () => {
    test('a file without a lifetime never expires', async () => {
      const res = await uploadBase64({ filename: 'plain.pdf' });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.expires_at).toBeNull();
      expect(res.body.delete_after).toBeNull();
      expect(res.body.consumed_by_generation_id).toBeNull();
    });

    test('expires_in sets expires_at that many seconds ahead', async () => {
      const before = Date.now();
      const res = await uploadBase64({
        filename: 'ttl.pdf',
        expires_in: 3600,
      });

      expect(res.status).toBe(201);
      const expiresAt = new Date(res.body.expires_at).getTime();
      expect(expiresAt).toBeGreaterThanOrEqual(before + HOUR_MS - 1000);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + HOUR_MS + 1000);
      expect(res.body.delete_after).toBeNull();
    });

    test('expires_at is kept as given', async () => {
      const expiresAt = new Date(Date.now() + 2 * HOUR_MS).toISOString();
      const res = await uploadBase64({
        filename: 'at.pdf',
        expires_at: expiresAt,
      });

      expect(res.status).toBe(201);
      expect(new Date(res.body.expires_at).toISOString()).toBe(expiresAt);
    });

    test('delete_after without a lifetime gets the default ceiling', async () => {
      const before = Date.now();
      const res = await uploadBase64({
        filename: 'single-default.pdf',
        delete_after: 'generation',
      });

      expect(res.status).toBe(201);
      expect(res.body.delete_after).toBe('generation');
      const expiresAt = new Date(res.body.expires_at).getTime();
      expect(expiresAt).toBeGreaterThanOrEqual(before + 24 * HOUR_MS - 1000);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + 24 * HOUR_MS + 1000);
    });

    test('expires_in and expires_at together are refused', async () => {
      const res = await uploadBase64({
        filename: 'both.pdf',
        expires_in: 60,
        expires_at: new Date(Date.now() + HOUR_MS).toISOString(),
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('an expires_at already past is refused', async () => {
      const res = await uploadBase64({
        filename: 'past.pdf',
        expires_at: new Date(Date.now() - 1000).toISOString(),
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a non-positive expires_in is refused', async () => {
      const res = await uploadBase64({ filename: 'zero.pdf', expires_in: 0 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('an unknown delete_after is refused', async () => {
      const res = await uploadBase64({
        filename: 'unknown.pdf',
        delete_after: 'conversation',
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('401 without a credential', async () => {
      const res = await testClient
        .post('/api/v1/files/upload/base64')
        .send({ project_id: projectId, content: 'eA==', expires_in: 60 });

      expect(res.status).toBe(401);
    });

    test('403 without files:UploadFile', async () => {
      const res = await authenticatedTestClient(noPermToken)
        .post('/api/v1/files/upload/base64')
        .send({ project_id: projectId, content: 'eA==', expires_in: 60 });

      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/v1/files/upload', () => {
    test('multipart fields carry the lifetime', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/files/upload')
        .attach('file', BYTES, {
          filename: 'multipart.pdf',
          contentType: 'application/pdf',
        })
        .field('project_id', projectId)
        .field('expires_in', '600')
        .field('delete_after', 'generation');

      expect(res.status).toBe(201);
      expect(res.body.delete_after).toBe('generation');
      const expiresAt = new Date(res.body.expires_at).getTime();
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + 600 * 1000 + 1000);
      expect(expiresAt).toBeGreaterThan(Date.now() + 500 * 1000);
    });

    test('a multipart expires_in that is not a whole number is refused', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/files/upload')
        .attach('file', BYTES, {
          filename: 'multipart-bad.pdf',
          contentType: 'application/pdf',
        })
        .field('project_id', projectId)
        .field('expires_in', 'soon');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('POST /api/v1/files/presigned-url', () => {
    test('the token carries the lifetime to the file it uploads', async () => {
      const issued = await authenticatedTestClient(adminToken)
        .post('/api/v1/files/presigned-url')
        .send({
          project_id: projectId,
          filename: 'browser.pdf',
          content_type: 'application/pdf',
          expires_in: 900,
          delete_after: 'generation',
        });
      expect(issued.status).toBe(201);

      const before = Date.now();
      const uploaded = await testClient
        .put(`/api/v1/files/upload/${issued.body.upload_token}`)
        .set('Content-Type', 'application/pdf')
        .send(BYTES);

      expect(uploaded.status).toBe(201);
      expect(uploaded.body.delete_after).toBe('generation');
      const expiresAt = new Date(uploaded.body.expires_at).getTime();
      expect(expiresAt).toBeGreaterThanOrEqual(before + 900 * 1000 - 1000);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + 900 * 1000 + 1000);
    });

    test('a lifetime the token could not give is refused when issued', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/files/presigned-url')
        .send({
          project_id: projectId,
          filename: 'browser-bad.pdf',
          expires_in: 60,
          expires_at: new Date(Date.now() + HOUR_MS).toISOString(),
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('POST /api/v1/files', () => {
    test('a record without bytes takes a lifetime', async () => {
      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/files')
        .send({
          project_id: projectId,
          filename: 'record.pdf',
          expires_in: 120,
        });

      expect(res.status).toBe(201);
      expect(res.body.expires_at).not.toBeNull();
    });
  });

  describe('PATCH /api/v1/files/:file_id/metadata', () => {
    const patch = (fileId: string, body: Record<string, unknown>) => {
      return authenticatedTestClient(adminToken)
        .patch(`/api/v1/files/${fileId}/metadata`)
        .send(body);
    };

    test('expires_at may be shortened', async () => {
      const created = await uploadBase64({
        filename: 'shorten.pdf',
        expires_in: 3600,
      });
      const shorter = new Date(Date.now() + 60 * 1000).toISOString();

      const res = await patch(created.body.id, { expires_at: shorter });

      expect(res.status).toBe(200);
      expect(new Date(res.body.expires_at).toISOString()).toBe(shorter);
    });

    test('a file that never expired may be given an expiry', async () => {
      const created = await uploadBase64({ filename: 'gain.pdf' });
      const later = new Date(Date.now() + HOUR_MS).toISOString();

      const res = await patch(created.body.id, { expires_at: later });

      expect(res.status).toBe(200);
      expect(new Date(res.body.expires_at).toISOString()).toBe(later);
    });

    test('expires_at may not be extended', async () => {
      const created = await uploadBase64({
        filename: 'extend.pdf',
        expires_in: 60,
      });

      const res = await patch(created.body.id, {
        expires_at: new Date(Date.now() + HOUR_MS).toISOString(),
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('expires_at may not be cleared', async () => {
      const created = await uploadBase64({
        filename: 'clear.pdf',
        expires_in: 60,
      });

      const res = await patch(created.body.id, { expires_at: null });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('delete_after may be set, and brings the default ceiling', async () => {
      const created = await uploadBase64({ filename: 'set-single.pdf' });

      const res = await patch(created.body.id, { delete_after: 'generation' });

      expect(res.status).toBe(200);
      expect(res.body.delete_after).toBe('generation');
      expect(res.body.expires_at).not.toBeNull();
    });

    test('delete_after may not be cleared', async () => {
      const fileId = await uploadSingleUse('keep-single.pdf');

      const res = await patch(fileId, { delete_after: null });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('an expires_at in the past expires the file at once', async () => {
      const created = await uploadBase64({
        filename: 'expire-now.pdf',
        expires_in: 3600,
      });

      const res = await patch(created.body.id, {
        expires_at: new Date(Date.now() - 1000).toISOString(),
      });

      expect(res.status).toBe(200);
      const read = await getFile(created.body.id);
      expect(read.status).toBe(404);
      expect(read.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });

    test('404 without files:UpdateFileMetadata', async () => {
      const created = await uploadBase64({
        filename: 'noperm.pdf',
        expires_in: 3600,
      });

      const res = await authenticatedTestClient(noPermToken)
        .patch(`/api/v1/files/${created.body.id}/metadata`)
        .send({ expires_at: new Date(Date.now() - 1000).toISOString() });

      expect(res.status).toBe(404);
      expect((await getFile(created.body.id)).status).toBe(200);
    });
  });

  describe('an expired file', () => {
    test('is gone from every read before any sweep runs', async () => {
      const created = await uploadBase64({
        filename: 'expired-reads.pdf',
        expires_in: 3600,
      });
      const fileId = created.body.id;
      await authenticatedTestClient(adminToken)
        .patch(`/api/v1/files/${fileId}/metadata`)
        .send({ expires_at: new Date(Date.now() - 1000).toISOString() });

      const [read, download, listed] = await Promise.all([
        getFile(fileId),
        authenticatedTestClient(adminToken).get(
          `/api/v1/files/${fileId}/download`
        ),
        authenticatedTestClient(adminToken).get(
          `/api/v1/files?project_id=${projectId}&limit=100`
        ),
      ]);

      expect(read.status).toBe(404);
      expect(download.status).toBe(404);
      const ids = (listed.body.data as Array<{ id: string }>).map((file) => {
        return file.id;
      });
      expect(ids).not.toContain(fileId);
    });

    test('frees its path for a new file before any sweep runs', async () => {
      const first = await uploadBase64({
        filename: 'reused-name.pdf',
        expires_in: 3600,
      });
      await authenticatedTestClient(adminToken)
        .patch(`/api/v1/files/${first.body.id}/metadata`)
        .send({ expires_at: new Date(Date.now() - 1000).toISOString() });

      const second = await uploadBase64({ filename: 'reused-name.pdf' });

      expect(second.status).toBe(201);
      expect(second.body.id).not.toBe(first.body.id);
    });

    test('does not keep its project from being deleted', async () => {
      const project = await authenticatedTestClient(adminToken)
        .post('/api/v1/projects')
        .send({ name: 'filelifetime-teardown' });
      expect(project.status).toBe(201);
      const created = await authenticatedTestClient(adminToken)
        .post('/api/v1/files/upload/base64')
        .send({
          project_id: project.body.id,
          filename: 'expired-teardown.txt',
          content: Buffer.from('x').toString('base64'),
          expires_in: 3600,
        });
      await authenticatedTestClient(adminToken)
        .patch(`/api/v1/files/${created.body.id}/metadata`)
        .send({ expires_at: new Date(Date.now() - 1000).toISOString() });

      const res = await authenticatedTestClient(adminToken).delete(
        `/api/v1/projects/${project.body.id}?force=true`
      );

      expect(res.status).toBe(204);
    });

    test('is refused by a generation', async () => {
      const created = await uploadBase64({
        filename: 'expired-gen.pdf',
        expires_in: 3600,
      });
      await authenticatedTestClient(adminToken)
        .patch(`/api/v1/files/${created.body.id}/metadata`)
        .send({ expires_at: new Date(Date.now() - 1000).toISOString() });

      const res = await authenticatedTestClient(adminToken)
        .post(`/api/v1/agents/${agentId}/generate?wait=true`)
        .send({ messages: fileMessage(created.body.id) });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });
  });

  describe('POST /api/v1/agents/:agent_id/generate', () => {
    test('a single-use file is read, then deleted when the generation completes', async () => {
      const fileId = await uploadSingleUse('exam-completed.pdf');
      const sentBefore = stub.requests().length;

      const res = await authenticatedTestClient(adminToken)
        .post(`/api/v1/agents/${agentId}/generate?wait=true`)
        .send({ messages: fileMessage(fileId) });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      const sent = stub.requests().slice(sentBefore).join('\n');
      expect(sent).toContain(BYTES.toString('base64'));

      const read = await getFile(fileId);
      expect(read.status).toBe(404);
    });

    test('a single-use file is deleted when the generation fails', async () => {
      const fileId = await uploadSingleUse('exam-failed.pdf');
      stub.failNext();

      const res = await authenticatedTestClient(adminToken)
        .post(`/api/v1/agents/${agentId}/generate?wait=true`)
        .send({ messages: fileMessage(fileId) });

      expect(res.body.status ?? res.body.error?.code).toBeDefined();
      const status = await pollUntil({
        read: async () => {
          return (await getFile(fileId)).status;
        },
        done: (value) => {
          return value === 404;
        },
      });
      expect(status).toBe(404);
    });

    test('a single-use file is claimed by the running generation and refused to another', async () => {
      const fileId = await uploadSingleUse('exam-held.pdf');
      stub.hold();
      try {
        const started = await authenticatedTestClient(adminToken)
          .post(`/api/v1/agents/${agentId}/generate`)
          .send({ messages: fileMessage(fileId) });
        expect(started.status).toBe(202);
        const generationId = started.body.generation_id;

        const claimed = await getFile(fileId);
        expect(claimed.status).toBe(200);
        expect(claimed.body.consumed_by_generation_id).toBe(generationId);

        const second = await authenticatedTestClient(adminToken)
          .post(`/api/v1/agents/${agentId}/generate?wait=true`)
          .send({ messages: fileMessage(fileId) });

        expect(second.status).toBe(409);
        expect(second.body.error.code).toBe('FILE_CONSUMED');
      } finally {
        stub.release();
      }
      const status = await pollUntil({
        read: async () => {
          return (await getFile(fileId)).status;
        },
        done: (value) => {
          return value === 404;
        },
      });
      expect(status).toBe(404);
    });

    test('an ordinary file stays after the generation', async () => {
      const created = await uploadBase64({ filename: 'kept.pdf' });

      const res = await authenticatedTestClient(adminToken)
        .post(`/api/v1/agents/${agentId}/generate?wait=true`)
        .send({ messages: fileMessage(created.body.id) });

      expect(res.status).toBe(200);
      const read = await getFile(created.body.id);
      expect(read.status).toBe(200);
      expect(read.body.consumed_by_generation_id).toBeNull();
    });
  });

  describe('POST /api/v1/conversations/:conversation_id/messages', () => {
    test('a single-use file is refused as a turn file', async () => {
      const fileId = await uploadSingleUse('exam-turn.pdf');
      const conversation = await authenticatedTestClient(adminToken)
        .post('/api/v1/conversations')
        .send({ project_id: projectId });
      expect(conversation.status).toBe(201);

      const res = await authenticatedTestClient(adminToken)
        .post(`/api/v1/conversations/${conversation.body.id}/messages`)
        .send({ role: 'user', message: 'Look', file_ids: [fileId] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('a file that only expires is accepted as a turn file', async () => {
      const created = await uploadBase64({
        filename: 'expiring-turn.pdf',
        expires_in: 3600,
      });
      const conversation = await authenticatedTestClient(adminToken)
        .post('/api/v1/conversations')
        .send({ project_id: projectId });

      const res = await authenticatedTestClient(adminToken)
        .post(`/api/v1/conversations/${conversation.body.id}/messages`)
        .send({ role: 'user', message: 'Look', file_ids: [created.body.id] });

      expect(res.status).toBe(201);
    });
  });

  describe('POST /api/v1/documents/ingest', () => {
    test('a single-use file is never ingested', async () => {
      const fileId = await uploadSingleUse('exam-ingest.pdf');

      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/documents/ingest')
        .send({ project_id: projectId, file_id: fileId });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('FILE_NOT_INGESTIBLE');
    });

    test('an expiring file is never ingested', async () => {
      const created = await uploadBase64({
        filename: 'expiring-ingest.pdf',
        expires_in: 3600,
      });

      const res = await authenticatedTestClient(adminToken)
        .post('/api/v1/documents/ingest')
        .send({ project_id: projectId, file_id: created.body.id });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('FILE_NOT_INGESTIBLE');
    });

    test('a lifetime may not be given to a file a document is made from', async () => {
      const created = await authenticatedTestClient(adminToken)
        .post('/api/v1/files/upload/base64')
        .send({
          project_id: projectId,
          filename: 'ingested.txt',
          content: Buffer.from('plain text body').toString('base64'),
          content_type: 'text/plain',
        });
      const ingested = await authenticatedTestClient(adminToken)
        .post('/api/v1/documents/ingest?wait=true')
        .send({ project_id: projectId, file_id: created.body.id });
      expect(ingested.status).toBe(201);

      const res = await authenticatedTestClient(adminToken)
        .patch(`/api/v1/files/${created.body.id}/metadata`)
        .send({ delete_after: 'generation' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('FILE_HAS_DEPENDENTS');
    });
  });

  test('a member reads the lifetime fields', async () => {
    const fileId = await uploadSingleUse('member-read.pdf');

    const res = await authenticatedTestClient(userToken).get(
      `/api/v1/files/${fileId}`
    );

    expect(res.status).toBe(200);
    expect(res.body.delete_after).toBe('generation');
    expect(res.body.consumed_by_generation_id).toBeNull();
  });
});
