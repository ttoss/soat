import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { DISTINCT_COUNT_COLUMNS } from 'src/lib/usageAggregateSql';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

type Totals = { event_count: number; distinct: Record<string, number> };

/**
 * Every attribution kind is metered once, every entity behind it is deleted,
 * and no `totals.distinct` key moves: a metered entity stays counted for as
 * long as its events exist.
 */
describe('GET /api/v1/usage/aggregate — totals.distinct across deletions', () => {
  let stubServer: Server;
  let adminToken: string;
  let projectId: string;
  let before: Totals;
  let after: Totals;

  // Answers every request as an OpenAI-compatible completion: the agent's
  // provider and the http tool both call it.
  const startStubServer = async (): Promise<string> => {
    stubServer = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-distinct',
            object: 'chat.completion',
            created: 0,
            model: 'stub-model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'metered' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
          })
        );
      });
    });
    await new Promise<void>((resolve) => {
      stubServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = stubServer.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  const readTotals = async (): Promise<Totals> => {
    const res = await authenticatedTestClient(adminToken).get(
      `/api/v1/usage/aggregate?project_id=${projectId}` +
        '&group_by=orchestration_run&include=distinct'
    );
    expect(res.status).toBe(200);
    return res.body.totals;
  };

  const post = async (path: string, body: Record<string, unknown>) => {
    const res = await authenticatedTestClient(adminToken).post(path).send(body);
    expect(res.status).toBeLessThan(300);
    return res.body;
  };

  const remove = async (path: string) => {
    const res = await authenticatedTestClient(adminToken).delete(path);
    expect({ path, status: res.status, error: res.body.error?.code }).toEqual({
      path,
      status: 204,
      error: undefined,
    });
  };

  beforeAll(async () => {
    const stubBaseUrl = await startStubServer();
    const setup = await setupProjectWithUsers({
      prefix: 'usage-distinct-deletion',
      policyActions: [],
      createNoPermUser: false,
    });
    adminToken = setup.adminToken;
    projectId = setup.projectId;

    const provider = await post('/api/v1/ai-providers', {
      project_id: projectId,
      name: 'Deletion Stub Provider',
      provider: 'ollama',
      default_model: 'stub-model',
      base_url: stubBaseUrl,
    });
    const agent = await post('/api/v1/agents', {
      project_id: projectId,
      ai_provider_id: provider.id,
      name: 'Deleted Agent',
    });

    // A session turn attributes the agent, its generation and trace, the
    // provider, the actor and the session.
    const actor = await post('/api/v1/actors', {
      project_id: projectId,
      name: 'Deleted Actor',
    });
    const session = await post('/api/v1/sessions', {
      agent_id: agent.id,
      actor_id: actor.id,
    });
    await post(`/api/v1/sessions/${session.id}/messages`, { message: 'hi' });
    const turn = await post(
      `/api/v1/sessions/${session.id}/generate?wait=true`,
      {}
    );
    expect(turn.status).toBe('completed');

    const orchestration = await post('/api/v1/orchestrations', {
      project_id: projectId,
      name: 'Deleted Orchestration',
      nodes: [{ id: 'node', type: 'agent', agent_id: agent.id }],
      edges: [],
    });
    const run = await post('/api/v1/orchestration-runs', {
      wait: true,
      orchestration_id: orchestration.id,
      input: {},
    });
    expect(run.status).toBe('succeeded');

    const tool = await post('/api/v1/tools', {
      project_id: projectId,
      name: 'deleted-tool',
      type: 'http',
      execute: { url: `${stubBaseUrl}/tool`, method: 'POST' },
    });
    await post(`/api/v1/tools/${tool.id}/call`, { input: {} });

    before = await readTotals();

    await remove(`/api/v1/tools/${tool.id}`);
    await remove(`/api/v1/orchestrations/${orchestration.id}`);
    await remove(`/api/v1/sessions/${session.id}`);
    await remove(`/api/v1/actors/${actor.id}`);
    await remove(`/api/v1/agents/${agent.id}?force=true`);
    await remove(`/api/v1/ai-providers/${provider.id}?force=true`);

    after = await readTotals();
  }, 90000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      stubServer.close((err) => {
        return err ? reject(err) : resolve();
      });
    });
  });

  test('the scenario meters every distinct key', () => {
    for (const key of Object.keys(DISTINCT_COUNT_COLUMNS)) {
      expect({ key, count: before.distinct[key] }).toEqual({
        key,
        count: expect.any(Number),
      });
      expect(before.distinct[key]).toBeGreaterThan(0);
    }
  });

  test('deleting the entities removes no event', () => {
    expect(after.event_count).toBe(before.event_count);
  });

  test.each(Object.keys(DISTINCT_COUNT_COLUMNS))(
    '%s is unchanged after its entity is deleted',
    (key) => {
      expect(after.distinct[key]).toBe(before.distinct[key]);
    }
  );
});
