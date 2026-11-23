import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { nodeExecutionsOf } from '../../fixtures/nodeExecutions';
import { authenticatedTestClient } from '../../testClient';

/**
 * A node that fails once its retries are spent routes along an edge whose
 * `condition` is `error:<CODE>` (that code only) or `error` (any code); with
 * no matching edge the run fails.
 */

type RunBody = {
  id: string;
  status: string;
  error: { code: string; message: string } | null;
  state: Record<string, unknown>;
};

let adminToken: string;
let userToken: string;
let projectId: string;
let getToolId: string;
let notFoundToolId: string;
let unavailableToolId: string;
let server: http.Server;
let hits: Record<string, number>;
let orchSeq = 0;

const createTool = async (body: Record<string, unknown>) => {
  const res = await authenticatedTestClient(adminToken)
    .post('/api/v1/tools')
    .send({ project_id: projectId, ...body });
  expect(res.status).toBe(201);
  return res.body.id as string;
};

const postOrchestration = (args: { nodes: unknown[]; edges: unknown[] }) => {
  orchSeq += 1;
  return authenticatedTestClient(userToken)
    .post('/api/v1/orchestrations')
    .send({
      project_id: projectId,
      name: `Error Edges ${orchSeq}`,
      nodes: args.nodes,
      edges: args.edges,
    });
};

const run = async (args: {
  nodes: unknown[];
  edges: unknown[];
}): Promise<RunBody> => {
  const created = await postOrchestration(args);
  expect(created.status).toBe(201);
  const res = await authenticatedTestClient(userToken)
    .post('/api/v1/orchestration-runs')
    .send({ wait: true, orchestration_id: created.body.id, input: {} });
  expect(res.status).toBe(201);
  return res.body as RunBody;
};

const executionsOf = async (runBody: RunBody, nodeId: string) => {
  return (
    await nodeExecutionsOf({ token: userToken, runId: runBody.id })
  ).filter((execution) => {
    return execution.node_id === nodeId;
  });
};

/** A builtin `get-tool` call on an id that does not exist: `404`. */
const lookupNode = (extra: Record<string, unknown> = {}) => {
  return {
    id: 'lookup',
    type: 'tool',
    tool_id: getToolId,
    operation_id: 'get-tool',
    input_mapping: { tool_id: 'tool_doesnotexist' },
    ...extra,
  };
};

const fallbackNode = {
  id: 'fallback',
  type: 'transform',
  expression: { var: 'nodes.lookup.error.code' },
  state_mapping: { caught: { var: 'output.result' } },
};

const nextNode = { id: 'next', type: 'transform', expression: 'found' };

beforeAll(async () => {
  process.env.ORCHESTRATION_WORKER_DISABLED = 'true';
  hits = {};
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const path = req.url ?? '';
      hits[path] = (hits[path] ?? 0) + 1;
      const status = path === '/unavailable' ? 503 : 404;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'no' }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const setup = await setupProjectWithUsers({
    prefix: 'ercedges',
    policyActions: [
      'tools:CallTool',
      'tools:GetTool',
      'orchestrations:CreateOrchestration',
      'orchestrations:StartRun',
      'orchestrations:GetRun',
    ],
    createNoPermUser: false,
  });
  adminToken = setup.adminToken;
  userToken = setup.userToken;
  projectId = setup.projectId;

  getToolId = await createTool({
    name: 'get-tool',
    type: 'builtin',
    actions: ['get-tool'],
  });
  notFoundToolId = await createTool({
    name: 'not-found',
    type: 'http',
    execute: { url: `${base}/missing`, method: 'POST' },
  });
  unavailableToolId = await createTool({
    name: 'unavailable',
    type: 'http',
    execute: { url: `${base}/unavailable`, method: 'POST' },
  });
});

afterAll(async () => {
  delete process.env.ORCHESTRATION_WORKER_DISABLED;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

describe('a failed node with an error edge', () => {
  test('a 404 follows the error:RESOURCE_NOT_FOUND edge, not the success edge', async () => {
    const result = await run({
      nodes: [lookupNode(), fallbackNode, nextNode],
      edges: [
        { from: 'lookup', to: 'next' },
        {
          from: 'lookup',
          to: 'fallback',
          condition: 'error:RESOURCE_NOT_FOUND',
        },
      ],
    });

    expect(result.status).toBe('completed');
    expect(result.state.caught).toBe('RESOURCE_NOT_FOUND');
    expect(await executionsOf(result, 'next')).toEqual([
      expect.objectContaining({ status: 'skipped' }),
    ]);
  });

  test('the failed execution records the error as its output', async () => {
    const result = await run({
      nodes: [lookupNode(), fallbackNode],
      edges: [
        {
          from: 'lookup',
          to: 'fallback',
          condition: 'error:RESOURCE_NOT_FOUND',
        },
      ],
    });

    const [execution] = await executionsOf(result, 'lookup');
    expect(execution.status).toBe('failed');
    expect(execution.error).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(execution.output).toEqual({ error: execution.error });
  });

  test('another code fails the run when only an error:<CODE> edge leaves the node', async () => {
    const result = await run({
      nodes: [
        { id: 'lookup', type: 'tool', tool_id: notFoundToolId },
        fallbackNode,
      ],
      edges: [
        {
          from: 'lookup',
          to: 'fallback',
          condition: 'error:RESOURCE_NOT_FOUND',
        },
      ],
    });

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('TOOL_HTTP_ERROR');
    expect(await executionsOf(result, 'fallback')).toEqual([]);
  });

  test('an error edge catches any code', async () => {
    const result = await run({
      nodes: [
        { id: 'lookup', type: 'tool', tool_id: notFoundToolId },
        fallbackNode,
      ],
      edges: [{ from: 'lookup', to: 'fallback', condition: 'error' }],
    });

    expect(result.status).toBe('completed');
    expect(result.state.caught).toBe('TOOL_HTTP_ERROR');
  });

  test('retries run before the error routes', async () => {
    hits['/unavailable'] = 0;
    const result = await run({
      nodes: [
        {
          id: 'lookup',
          type: 'tool',
          tool_id: unavailableToolId,
          retry: { max_attempts: 3, backoff: { delay_ms: 0 } },
        },
        fallbackNode,
      ],
      edges: [{ from: 'lookup', to: 'fallback', condition: 'error' }],
    });

    expect(result.status).toBe('completed');
    expect(hits['/unavailable']).toBe(3);
    expect(
      (await executionsOf(result, 'lookup')).map((execution) => {
        return execution.attempt;
      })
    ).toEqual([1, 2, 3]);
  });

  test('a node with no error edge still fails the run', async () => {
    const result = await run({
      nodes: [lookupNode(), nextNode],
      edges: [{ from: 'lookup', to: 'next' }],
    });

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('an error:<CODE> edge on write', () => {
  test('naming an unknown code is refused', async () => {
    const res = await postOrchestration({
      nodes: [lookupNode(), fallbackNode],
      edges: [
        { from: 'lookup', to: 'fallback', condition: 'error:NOT_A_CODE' },
      ],
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('edges[0].condition');
  });
});
