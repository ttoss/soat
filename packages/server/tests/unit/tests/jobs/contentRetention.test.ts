import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { sweepExpiredTraceContent } from 'src/lib/contentRetention';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The daily retention sweep, driven as the scheduler tick with an injected
 * `now` (unit tests never import `server.ts`). Content is written by real turns
 * against a local OpenAI-compatible stub, and the purge is read back through
 * `GET /api/v1/traces/:trace_id`, `GET /api/v1/generations/:generation_id` and
 * `GET /api/v1/files/:file_id`.
 */
describe('Trace content retention sweep', () => {
  let adminToken: string;
  let stubServer: Server;
  let stubBaseUrl: string;
  let seq = 0;
  /** Every turn is written "now"; the sweep is handed a later clock. */
  const seededAt = new Date();

  const daysAhead = (days: number) => {
    return new Date(seededAt.getTime() + days * DAY_MS);
  };

  const asAdmin = () => {
    return authenticatedTestClient(adminToken);
  };

  /** A project with a retention window (or none) and an agent to write in it. */
  const createProject = async (retentionDays?: number) => {
    seq += 1;
    const project = await asAdmin()
      .post('/api/v1/projects')
      .send({ name: `Retention ${seq}` });
    expect(project.status).toBe(201);
    if (retentionDays !== undefined) {
      const patched = await asAdmin()
        .patch(`/api/v1/projects/${project.body.id}`)
        .send({ trace_content_retention_days: retentionDays });
      expect(patched.status).toBe(200);
      expect(patched.body.trace_content_retention_days).toBe(retentionDays);
    }
    const provider = await asAdmin()
      .post('/api/v1/ai-providers')
      .send({
        project_id: project.body.id,
        name: `retention-stub-${seq}`,
        provider: 'ollama',
        default_model: 'stub-model',
        base_url: stubBaseUrl,
      });
    expect(provider.status).toBe(201);
    const agent = await asAdmin()
      .post('/api/v1/agents')
      .send({
        project_id: project.body.id,
        ai_provider_id: provider.body.id,
        name: `retention-agent-${seq}`,
      });
    expect(agent.status).toBe(201);
    return agent.body.id as string;
  };

  /** One finished turn; returns its generation and trace ids. */
  const turn = async (args: {
    agentId: string;
    body?: Record<string, unknown>;
  }) => {
    const res = await asAdmin()
      .post(`/api/v1/agents/${args.agentId}/generate?wait=true`)
      .send({
        messages: [{ role: 'user', content: 'case content' }],
        ...args.body,
      });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    return {
      generationId: res.body.id as string,
      traceId: res.body.trace_id as string,
    };
  };

  const getTrace = async (traceId: string) => {
    const res = await asAdmin().get(`/api/v1/traces/${traceId}`);
    expect(res.status).toBe(200);
    return res.body as {
      file_id: string | null;
      content_redacted_at: string | null;
      content_redacted_by_principal_type: string | null;
      content_redacted_by_principal_id: string | null;
    };
  };

  beforeAll(async () => {
    stubServer = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-stub',
            object: 'chat.completion',
            created: 0,
            model: 'stub-model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'Done.' },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 2,
              total_tokens: 12,
            },
          })
        );
      });
    });
    await new Promise<void>((resolve) => {
      stubServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = stubServer.address() as AddressInfo;
    stubBaseUrl = `http://127.0.0.1:${port}`;

    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'retentionadmin', password: 'supersecret' });
    adminToken = await loginAs('retentionadmin', 'supersecret');
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      stubServer.close(() => {
        resolve();
      });
    });
  });

  describe('a project with no retention window', () => {
    test('keeps its content however old it is', async () => {
      const { traceId } = await turn({ agentId: await createProject() });

      await sweepExpiredTraceContent({ now: daysAhead(3650) });

      const trace = await getTrace(traceId);
      expect(trace.content_redacted_at).toBeNull();
      expect(trace.file_id).not.toBeNull();
    });
  });

  describe('a project with a 30-day window', () => {
    test('leaves content still inside the window', async () => {
      const { traceId } = await turn({ agentId: await createProject(30) });

      await sweepExpiredTraceContent({ now: daysAhead(29) });

      const trace = await getTrace(traceId);
      expect(trace.content_redacted_at).toBeNull();
      expect(trace.file_id).not.toBeNull();
    });

    test('purges expired content, steps file included, as the sweep', async () => {
      const { traceId } = await turn({ agentId: await createProject(30) });
      const before = await getTrace(traceId);
      expect(before.file_id).not.toBeNull();

      expect(
        await sweepExpiredTraceContent({ now: daysAhead(31) })
      ).toBeGreaterThanOrEqual(1);

      const trace = await getTrace(traceId);
      expect(trace.content_redacted_at).not.toBeNull();
      expect(trace.file_id).toBeNull();
      expect(trace.content_redacted_by_principal_type).toBe('system');
      expect(trace.content_redacted_by_principal_id).toBe('retention_sweep');
      // The bytes, not just the pointer: a purge that leaves the object is a
      // fake erasure.
      const file = await asAdmin().get(`/api/v1/files/${before.file_id}`);
      expect(file.status).toBe(404);
    });

    test('clears generation content but keeps the billing skeleton', async () => {
      const { generationId } = await turn({
        agentId: await createProject(30),
        body: { metadata: { ticket_id: 'OPS-1' } },
      });

      await sweepExpiredTraceContent({ now: daysAhead(31) });

      const res = await asAdmin().get(`/api/v1/generations/${generationId}`);
      expect(res.status).toBe(200);
      expect(res.body.metadata).toBeNull();
      expect(res.body.content_redacted_at).not.toBeNull();
      expect(res.body.status).toBe('completed');
      expect(res.body.started_at).not.toBeNull();
    });

    test('a trace already purged is neither re-stamped nor counted again', async () => {
      const agentId = await createProject(30);
      const { traceId } = await turn({ agentId });
      await sweepExpiredTraceContent({ now: daysAhead(31) });
      const firstStamp = (await getTrace(traceId)).content_redacted_at;

      // A steady-state sweep reads only what is still due.
      expect(await sweepExpiredTraceContent({ now: daysAhead(60) })).toBe(0);
      expect((await getTrace(traceId)).content_redacted_at).toBe(firstStamp);
    });

    test('a run is purged whole when its root expires', async () => {
      const agentId = await createProject(30);
      const root = await turn({ agentId });
      const child = await turn({
        agentId,
        body: { parent_trace_id: root.traceId, root_trace_id: root.traceId },
      });
      expect((await getTrace(child.traceId)).file_id).not.toBeNull();

      await sweepExpiredTraceContent({ now: daysAhead(31) });

      const purged = await getTrace(child.traceId);
      expect(purged.content_redacted_at).not.toBeNull();
      expect(purged.file_id).toBeNull();
    });

    test('a batch smaller than the backlog still drains it', async () => {
      const agentId = await createProject(30);
      const turns = [
        await turn({ agentId }),
        await turn({ agentId }),
        await turn({ agentId }),
      ];

      expect(
        await sweepExpiredTraceContent({ now: daysAhead(31), batchLimit: 2 })
      ).toBeGreaterThanOrEqual(3);

      for (const { traceId } of turns) {
        expect((await getTrace(traceId)).content_redacted_at).not.toBeNull();
      }
    });
  });

  describe('projects with different windows', () => {
    test('each is held to its own', async () => {
      const short = await turn({ agentId: await createProject(30) });
      const long = await turn({ agentId: await createProject(365) });

      await sweepExpiredTraceContent({ now: daysAhead(40) });

      expect(
        (await getTrace(short.traceId)).content_redacted_at
      ).not.toBeNull();
      expect((await getTrace(long.traceId)).content_redacted_at).toBeNull();
    });
  });
});
