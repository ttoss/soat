import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { USAGE_EVENT_DURABLE_IDS } from '@soat/postgresdb';
import {
  DISTINCT_COUNT_COLUMNS,
  USAGE_GROUP_BY,
} from 'src/lib/usageAggregateSql';
import { RECORDED_ID_COLUMNS } from 'src/lib/usageNarrowings';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { authenticatedTestClient } from '../../testClient';

type Totals = { event_count: number; distinct: Record<string, number> };

type UsageEvent = Record<string, unknown> & { id: string };

type Bucket = {
  key: string | null;
  ai_provider_id: string | null;
  event_count: number;
  cost_usd: number | null;
};

// Every attribution field an event carries, each naming an entity the
// scenario deletes.
const ATTRIBUTION_FIELDS = [
  'orchestration_run_id',
  'agent_id',
  'generation_id',
  'trace_id',
  'actor_id',
  'session_id',
  'ai_provider_id',
  'tool_id',
  'publisher_project_id',
  'document_id',
  'memory_store_id',
] as const;

// Every id narrowing a usage read takes that the event can answer itself.
const ID_FILTERS = [
  'orchestration_run_id',
  'agent_id',
  'generation_id',
  'trace_id',
  'actor_id',
  'session_id',
  'ai_provider_id',
  'tool_id',
  'publisher_project_id',
] as const;

type Snapshot = {
  totals: Totals;
  events: Map<string, UsageEvent>;
  groups: Record<string, Bucket[]>;
  filtered: Record<string, { listed: number; aggregated: number }>;
};

/**
 * Every attribution kind is metered once and every entity behind it is
 * deleted. Nothing a usage read answers moves: a metered entity stays counted,
 * named on its events, bucketed under its id and selectable by it for as long
 * as its events exist.
 */
describe('usage reads across deletions', () => {
  let stubServer: Server;
  let adminToken: string;
  let projectId: string;
  let before: Totals;
  let after: Totals;
  let beforeSnapshot: Snapshot;
  let afterSnapshot: Snapshot;
  // One id per narrowing, read off the events before anything is deleted.
  const sampleIds: Record<string, string> = {};

  // Answers every request as an OpenAI-compatible completion: the agent's
  // provider and the http tool both call it. Embeddings use the suite's stub.
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

  // A project key, so the listing — which takes no `project_id` — reads this
  // project's events alone.
  let projectKey: string;

  const get = async (path: string) => {
    const res = await authenticatedTestClient(projectKey).get(path);
    expect({ path, status: res.status }).toEqual({ path, status: 200 });
    return res.body;
  };

  const readEvents = async (): Promise<Map<string, UsageEvent>> => {
    const page = await get('/api/v1/usage/events?limit=100');
    expect(page.total).toBeLessThanOrEqual(100);
    return new Map(
      (page.data as UsageEvent[]).map((event) => {
        return [event.id, event];
      })
    );
  };

  const readGroups = async (groupBy: string): Promise<Bucket[]> => {
    const body = await get(
      `/api/v1/usage/aggregate?project_id=${projectId}` +
        `&group_by=${groupBy}&limit=100`
    );
    expect(body.groups.total).toBeLessThanOrEqual(100);
    return (body.groups.data as Bucket[]).map((group) => {
      return {
        key: group.key,
        ai_provider_id: group.ai_provider_id,
        event_count: group.event_count,
        cost_usd: group.cost_usd,
      };
    });
  };

  const readFiltered = async (filter: string, id: string) => {
    const query = `${filter}=${id}&limit=100`;
    const listed = await get(`/api/v1/usage/events?${query}`);
    const aggregated = await get(
      `/api/v1/usage/aggregate?project_id=${projectId}&${query}`
    );
    return { listed: listed.total, aggregated: aggregated.totals.event_count };
  };

  const snapshot = async (): Promise<Snapshot> => {
    const groups: Record<string, Bucket[]> = {};
    for (const groupBy of USAGE_GROUP_BY) {
      groups[groupBy] = await readGroups(groupBy);
    }
    const filtered: Snapshot['filtered'] = {};
    for (const filter of ID_FILTERS) {
      filtered[filter] = await readFiltered(filter, sampleIds[filter]);
    }
    return {
      totals: await readTotals(),
      events: await readEvents(),
      groups,
      filtered,
    };
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

    // A tool node calling a tool another project shares attributes that
    // project as publisher.
    const publisher = await post('/api/v1/projects', { name: 'Publisher' });
    const sharedTool = await post('/api/v1/tools', {
      project_id: publisher.id,
      name: 'shared-tool',
      type: 'http',
      execute: { url: `${stubBaseUrl}/shared`, method: 'POST' },
    });
    const share = await post('/api/v1/shares', {
      project_id: publisher.id,
      resource: `srn:${publisher.id}:tool:${sharedTool.id}`,
      actions: ['tools:CallTool'],
      grantee: projectId,
    });
    const granteeKey = await post('/api/v1/api-keys', {
      name: 'Grantee key',
      project_id: projectId,
    });
    projectKey = granteeKey.key;
    const accepted = await authenticatedTestClient(granteeKey.key).post(
      `/api/v1/shares/${share.id}/accept`
    );
    expect(accepted.status).toBe(200);
    const sharedOrchestration = await post('/api/v1/orchestrations', {
      project_id: projectId,
      name: 'Shared Tool Orchestration',
      nodes: [{ id: 'call', type: 'tool', tool_id: sharedTool.id }],
      edges: [],
    });
    const sharedRun = await post('/api/v1/orchestration-runs', {
      wait: true,
      orchestration_id: sharedOrchestration.id,
      input: {},
    });
    expect(sharedRun.status).toBe('succeeded');

    // Embedding a document's chunks and a memory's content attributes the
    // document and the memory store.
    const document = await post('/api/v1/documents', {
      project_id: projectId,
      content: 'alpha beta gamma delta',
      path: '/usage-distinct-deletion/doc.txt',
    });
    const memoryStore = await post('/api/v1/memory-stores', {
      project_id: projectId,
      name: 'Deleted Memory Store',
    });
    await post('/api/v1/memories', {
      memory_store_id: memoryStore.id,
      content: 'the customer prefers email',
    });

    // Chunk embedding runs after the create answers.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      before = await readTotals();
      if (before.distinct.documents > 0) break;
      await new Promise((resolve) => {
        return setImmediate(resolve);
      });
    }

    for (const event of (await readEvents()).values()) {
      for (const filter of ID_FILTERS) {
        const value = event[filter];
        if (typeof value === 'string') sampleIds[filter] ??= value;
      }
    }
    beforeSnapshot = await snapshot();

    await remove(`/api/v1/documents/${document.id}`);
    await remove(`/api/v1/memory-stores/${memoryStore.id}`);
    await remove(`/api/v1/tools/${tool.id}`);
    await remove(`/api/v1/orchestrations/${orchestration.id}`);
    await remove(`/api/v1/sessions/${session.id}`);
    await remove(`/api/v1/actors/${actor.id}`);
    await remove(`/api/v1/agents/${agent.id}?force=true`);
    await remove(`/api/v1/ai-providers/${provider.id}?force=true`);
    await remove(`/api/v1/projects/${publisher.id}?force=true`);

    after = await readTotals();
    afterSnapshot = await snapshot();
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

  const snakeCase = (camel: string): string => {
    return camel.replace(/[A-Z]/g, (letter) => {
      return `_${letter.toLowerCase()}`;
    });
  };

  test('every attribution the event records is checked here', () => {
    expect([...ATTRIBUTION_FIELDS].sort()).toEqual(
      USAGE_EVENT_DURABLE_IDS.map((pair) => {
        return snakeCase(pair.foreignKey);
      }).sort()
    );
  });

  test('every id narrowing matched on a recorded id is checked here', () => {
    expect([...ID_FILTERS].sort()).toEqual(
      Object.keys(RECORDED_ID_COLUMNS).map(snakeCase).sort()
    );
  });

  describe('GET /api/v1/usage/events', () => {
    test.each(ATTRIBUTION_FIELDS)(
      'the scenario meters an event naming a %s',
      (field) => {
        const named = [...beforeSnapshot.events.values()].filter((event) => {
          return typeof event[field] === 'string';
        });
        expect(named.length).toBeGreaterThan(0);
      }
    );

    test.each(ATTRIBUTION_FIELDS)(
      'every event still names its %s after the entity is deleted',
      (field) => {
        for (const [id, event] of beforeSnapshot.events) {
          expect({
            id,
            [field]: afterSnapshot.events.get(id)?.[field],
          }).toEqual({ id, [field]: event[field] });
        }
      }
    );
  });

  describe('GET /api/v1/usage/aggregate', () => {
    test.each([...USAGE_GROUP_BY])(
      'group_by=%s: the scenario meters a named bucket',
      (groupBy) => {
        const named = beforeSnapshot.groups[groupBy].filter((bucket) => {
          return bucket.key !== null;
        });
        expect(named.length).toBeGreaterThan(0);
      }
    );

    test.each([...USAGE_GROUP_BY])(
      'group_by=%s keeps every bucket after the entities are deleted',
      (groupBy) => {
        expect(afterSnapshot.groups[groupBy]).toEqual(
          beforeSnapshot.groups[groupBy]
        );
      }
    );
  });

  describe.each([...ID_FILTERS])('?%s= naming a deleted entity', (filter) => {
    test('narrows to that entity before it is deleted', () => {
      const { listed, aggregated } = beforeSnapshot.filtered[filter];
      expect(listed).toBeGreaterThan(0);
      expect(listed).toBeLessThan(beforeSnapshot.events.size);
      expect(aggregated).toBe(listed);
    });

    test('still selects the same events after it is deleted', () => {
      expect(afterSnapshot.filtered[filter]).toEqual(
        beforeSnapshot.filtered[filter]
      );
    });
  });
});
