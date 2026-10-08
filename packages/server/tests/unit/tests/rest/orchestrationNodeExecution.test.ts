import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { db } from 'src/db';
import { DomainError } from 'src/errors';
import type { GenerationResult } from 'src/lib/agentGenerationTypes';
import { REQUIRED_NODE_FIELDS } from 'src/lib/orchestrationNodeFields';
import type { OrchestrationNode } from 'src/lib/orchestrations';
import { wakeDueRuns } from 'src/lib/orchestrationScheduler';
import { drainQueueOnce } from 'src/lib/orchestrationWorker';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { nodeExecutionsOf } from '../../fixtures/nodeExecutions';
import { mockCreateGeneration } from '../../setupTestsAfterEnv';
import { authenticatedTestClient } from '../../testClient';

/**
 * What each node type does inside a run: the artifact it records, how it parks,
 * and how it fails. Every case is a real run started through
 * `POST /orchestration-runs`; the LLM is the only stand-in
 * (`mockCreateGeneration`), and `http` tools call a local server.
 *
 * The in-process worker kick is disabled so a background run is driven only by
 * the explicit `drainQueueOnce` / `wakeDueRuns` calls a test makes.
 */

type RunBody = {
  id: string;
  status: string;
  error: { code: string; message: string } | null;
  state: Record<string, unknown>;
  required_action: { prompt: string } | null;
};

let adminToken: string;
let userToken: string;
let projectId: string;
let agentId: string;
let echoToolId: string;
let unavailableToolId: string;
let primitiveToolId: string;
let childOrchestrationId: string;
let server: http.Server;
let orchSeq = 0;

const createTool = async (args: { name: string; url: string }) => {
  const res = await authenticatedTestClient(adminToken)
    .post('/api/v1/tools')
    .send({
      project_id: projectId,
      name: args.name,
      type: 'http',
      execute: { url: args.url, method: 'POST' },
    });
  expect(res.status).toBe(201);
  return res.body.id as string;
};

const createOrchestration = async (args: {
  nodes: unknown[];
  edges?: unknown[];
}) => {
  orchSeq += 1;
  const res = await authenticatedTestClient(userToken)
    .post('/api/v1/orchestrations')
    .send({
      project_id: projectId,
      name: `Node Execution ${orchSeq}`,
      nodes: args.nodes,
      edges: args.edges ?? [],
    });
  expect(res.status).toBe(201);
  return res.body.id as string;
};

const runToRest = async (orchestrationId: string): Promise<RunBody> => {
  const res = await authenticatedTestClient(userToken)
    .post('/api/v1/orchestration-runs')
    .send({ wait: true, orchestration_id: orchestrationId, input: {} });
  expect(res.status).toBe(201);
  return res.body as RunBody;
};

const startInBackground = async (orchestrationId: string) => {
  const res = await authenticatedTestClient(userToken)
    .post('/api/v1/orchestration-runs')
    .send({ orchestration_id: orchestrationId, input: {} });
  expect(res.status).toBe(201);
  expect(res.body.status).toBe('queued');
  return res.body.id as string;
};

const getRun = async (runId: string): Promise<RunBody> => {
  const res = await authenticatedTestClient(userToken).get(
    `/api/v1/orchestration-runs/${runId}`
  );
  expect(res.status).toBe(200);
  return res.body as RunBody;
};

const runRow = async (runId: string) => {
  const row = await db.OrchestrationRun.findOne({ where: { publicId: runId } });
  return row!;
};

/**
 * Wakes every due run as the scheduler would, then drives the `wake` task the
 * claim enqueued. The enqueue is dispatched detached from the claim, so the
 * drain waits for the task row rather than racing it.
 */
const wakeAndDrain = async (runId: string) => {
  const run = await runRow(runId);
  const claimed = await wakeDueRuns({ now: new Date(Date.now() + 600_000) });
  expect(claimed).toBe(1);
  for (let i = 0; i < 1000; i += 1) {
    const tasks = await db.OrchestrationRunTask.count({
      where: { orchestrationRunId: run.id as number },
    });
    if (tasks > 0) break;
  }
  expect(await drainQueueOnce()).toBe(1);
};

const executionsOf = async (run: RunBody, nodeId: string) => {
  return (await nodeExecutionsOf({ token: userToken, runId: run.id })).filter(
    (execution) => {
      return execution.node_id === nodeId;
    }
  );
};

beforeAll(async () => {
  process.env.ORCHESTRATION_WORKER_DISABLED = 'true';

  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url === '/unavailable') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'down' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.url === '/primitive' ? 'done' : { ok: true }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const setup = await setupProjectWithUsers({
    prefix: 'orchnodeexec',
    policyActions: [
      'orchestrations:CreateOrchestration',
      'orchestrations:UpdateOrchestration',
      'orchestrations:StartRun',
      'orchestrations:GetRun',
      'orchestrations:CancelRun',
      'activity:ListActivity',
    ],
    createNoPermUser: false,
  });
  adminToken = setup.adminToken;
  userToken = setup.userToken;
  projectId = setup.projectId;

  echoToolId = await createTool({ name: 'echo', url: `${base}/echo` });
  unavailableToolId = await createTool({
    name: 'unavailable',
    url: `${base}/unavailable`,
  });
  primitiveToolId = await createTool({
    name: 'primitive',
    url: `${base}/primitive`,
  });

  const providerRes = await authenticatedTestClient(adminToken)
    .post('/api/v1/ai-providers')
    .send({
      project_id: projectId,
      name: 'node-execution-provider',
      provider: 'ollama',
      default_model: 'llama3.2',
    });
  expect(providerRes.status).toBe(201);
  const agentRes = await authenticatedTestClient(adminToken)
    .post('/api/v1/agents')
    .send({
      project_id: projectId,
      name: 'node-execution-agent',
      ai_provider_id: providerRes.body.id,
    });
  expect(agentRes.status).toBe(201);
  agentId = agentRes.body.id;

  childOrchestrationId = await createOrchestration({
    nodes: [{ id: 'leaf', type: 'transform', expression: 1 }],
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

afterEach(() => {
  jest.clearAllMocks();
});

/**
 * A graph that reaches dispatch has normally passed validation, which refuses
 * a node missing its required field at author time. A definition stored before
 * its node type gained the requirement has not, so dispatch refuses it again.
 * The archived version is what a run executes; each case strips the field from
 * it after a valid create.
 */
describe('a stored node missing its required field', () => {
  const VALID_NODES: Partial<
    Record<OrchestrationNode['type'], () => Record<string, unknown>>
  > = {
    agent: () => {
      return { agent_id: agentId };
    },
    tool: () => {
      return { tool_id: echoToolId };
    },
    transform: () => {
      return { expression: 1 };
    },
    condition: () => {
      return { expression: 'yes' };
    },
    approval: () => {
      return { tool_id: echoToolId };
    },
    delay: () => {
      return { duration: '1s' };
    },
    loop: () => {
      return { orchestration_id: childOrchestrationId };
    },
    poll: () => {
      return {
        tool_id: echoToolId,
        interval: '1s',
        exit_condition: { '==': [{ var: 'response.ok' }, true] },
      };
    },
    emit_event: () => {
      return { event_type: 'custom.happened' };
    },
    sub_orchestration: () => {
      return { orchestration_id: childOrchestrationId };
    },
  };

  const toWireKey = (field: string): string => {
    return field.replace(/[A-Z]/g, (letter) => {
      return `_${letter.toLowerCase()}`;
    });
  };

  /** Creates a valid one-node graph, then strips `wireKey` from its archive. */
  const storeWithout = async (args: {
    type: OrchestrationNode['type'];
    fields: Record<string, unknown>;
    wireKey: string;
  }) => {
    const orchestrationId = await createOrchestration({
      nodes: [{ id: 'n1', type: args.type, ...args.fields }],
    });
    const orchestration = await db.Orchestration.findOne({
      where: { publicId: orchestrationId },
    });
    const archived = await db.OrchestrationVersion.findOne({
      where: { orchestrationId: orchestration!.id as number, version: 1 },
    });
    const config = structuredClone(archived!.config) as {
      nodes: Array<Record<string, unknown>>;
    };
    delete config.nodes[0][args.wireKey];
    await archived!.update({ config });
    return orchestrationId;
  };

  const entries = Object.entries(REQUIRED_NODE_FIELDS);

  test('every node type with a required field has a valid fixture here', () => {
    expect(
      entries
        .map(([type]) => {
          return type;
        })
        .sort()
    ).toEqual(Object.keys(VALID_NODES).sort());
  });

  test.each(entries)(
    'a %s node missing %s fails the run instead of dispatching',
    async (type, field) => {
      const nodeType = type as OrchestrationNode['type'];
      const orchestrationId = await storeWithout({
        type: nodeType,
        fields: VALID_NODES[nodeType]!(),
        wireKey: toWireKey(String(field)),
      });

      const run = await runToRest(orchestrationId);

      expect(run.status).toBe('failed');
      expect(run.error).toEqual({
        code: 'ORCHESTRATION_NODE_FAILED',
        message: `${type} node 'n1' missing ${String(field)}.`,
      });
    }
  );

  test.each([
    ['exit_condition', 'exitCondition'],
    ['interval', 'interval'],
  ])('a poll node missing its %s fails the run', async (wireKey, field) => {
    const orchestrationId = await storeWithout({
      type: 'poll',
      fields: VALID_NODES.poll!(),
      wireKey,
    });

    const run = await runToRest(orchestrationId);

    expect(run.status).toBe('failed');
    expect(run.error).toEqual({
      code: 'ORCHESTRATION_NODE_FAILED',
      message: `Poll node 'n1' missing ${field}.`,
    });
  });
});

describe('a poll node', () => {
  const pollOrchestration = (overrides: Record<string, unknown>) => {
    return createOrchestration({
      nodes: [
        {
          id: 'watch',
          type: 'poll',
          tool_id: echoToolId,
          interval: '1s',
          exit_condition: { '==': [{ var: 'response.ok' }, true] },
          ...overrides,
        },
      ],
    });
  };

  test('completes on the attempt whose response meets the exit condition', async () => {
    const run = await runToRest(await pollOrchestration({}));

    expect(run.status).toBe('succeeded');
    expect((await executionsOf(run, 'watch'))[0].output).toEqual({
      result: { ok: true },
      attempts: 1,
      conditionMet: true,
      timedOut: false,
    });
  });

  test('records a timeout when its last attempt misses the exit condition', async () => {
    const run = await runToRest(
      await pollOrchestration({
        exit_condition: { '==': [{ var: 'response.ok' }, false] },
        max_iterations: 1,
      })
    );

    expect(run.status).toBe('succeeded');
    expect((await executionsOf(run, 'watch'))[0].output).toEqual({
      result: { ok: true },
      attempts: 1,
      conditionMet: false,
      timedOut: true,
    });
  });

  test('fails the run on a timeout when fail_on_timeout is set', async () => {
    const run = await runToRest(
      await pollOrchestration({
        exit_condition: { '==': [{ var: 'response.ok' }, false] },
        max_iterations: 1,
        fail_on_timeout: true,
      })
    );

    expect(run.status).toBe('failed');
    expect(run.error?.code).toBe('ORCHESTRATION_POLL_EXHAUSTED');
  });
});

describe('an agent node', () => {
  const generation = (output: GenerationResult['output']): GenerationResult => {
    return {
      id: 'gen_nodeexec',
      traceId: 'trc_nodeexec',
      status: 'completed',
      output,
    };
  };

  const textOutput = (content: string, object?: unknown) => {
    return generation({
      model: 'llama3.2',
      content,
      finishReason: 'stop',
      ...(object === undefined ? {} : { object }),
    });
  };

  const SCHEMA = {
    type: 'object',
    properties: { city: { type: 'string' } },
  };

  const cases: Array<
    [string, object | undefined, GenerationResult, Record<string, unknown>]
  > = [
    [
      'parses JSON content when the node declares a schema',
      SCHEMA,
      textOutput('{"city":"Paris"}'),
      { content: '{"city":"Paris"}', object: { city: 'Paris' } },
    ],
    [
      'keeps the text and no object when declared-schema content is not JSON',
      SCHEMA,
      textOutput('not valid json'),
      { content: 'not valid json', object: null },
    ],
    [
      'keeps no object when declared-schema content parses to a non-object',
      SCHEMA,
      textOutput('[1,2,3]'),
      { content: '[1,2,3]', object: null },
    ],
    [
      "prefers the generation's structured object over re-parsing its text",
      SCHEMA,
      textOutput('The capital is Paris, but this text is not JSON.', {
        city: 'Paris',
      }),
      {
        content: 'The capital is Paris, but this text is not JSON.',
        object: { city: 'Paris' },
      },
    ],
    [
      'records a null-content artifact for a generation that requires action',
      SCHEMA,
      {
        id: 'gen_nodeexec',
        traceId: 'trc_nodeexec',
        status: 'requires_action',
        requiredAction: {
          type: 'submit_tool_outputs',
          toolCalls: [{ id: 'call_1', toolName: 'some_tool', args: {} }],
        },
      },
      { content: null, object: null },
    ],
    [
      "carries the agent's own structured object when the node declares no schema",
      undefined,
      textOutput('{"status":"ok"}', { status: 'ok' }),
      { content: '{"status":"ok"}', object: { status: 'ok' } },
    ],
    [
      'never parses JSON-shaped text when no schema applies',
      undefined,
      textOutput('{"incidental":true}'),
      { content: '{"incidental":true}', object: null },
    ],
  ];

  test.each(cases)('%s', async (_label, outputSchema, result, artifact) => {
    const orchestrationId = await createOrchestration({
      nodes: [
        {
          id: 'ask',
          type: 'agent',
          agent_id: agentId,
          ...(outputSchema ? { output_schema: outputSchema } : {}),
        },
      ],
    });
    mockCreateGeneration.mockResolvedValueOnce(result);

    const run = await runToRest(orchestrationId);

    expect(run.status).toBe('succeeded');
    expect((await executionsOf(run, 'ask'))[0].output).toEqual(artifact);
  });
});

describe('a tool node', () => {
  test('wraps a primitive tool result under `result`', async () => {
    const orchestrationId = await createOrchestration({
      nodes: [{ id: 'call', type: 'tool', tool_id: primitiveToolId }],
    });

    const run = await runToRest(orchestrationId);

    expect(run.status).toBe('succeeded');
    expect((await executionsOf(run, 'call'))[0].output).toEqual({
      result: 'done',
    });
  });

  test('records an action_executed activity entry naming the run', async () => {
    const orchestrationId = await createOrchestration({
      nodes: [{ id: 'call', type: 'tool', tool_id: echoToolId }],
    });

    const run = await runToRest(orchestrationId);
    expect(run.status).toBe('succeeded');

    // The entry is written fire-and-forget after the call returns.
    let entry: Record<string, unknown> | undefined;
    for (let i = 0; i < 200 && !entry; i += 1) {
      const res = await authenticatedTestClient(userToken).get(
        `/api/v1/activity?project_id=${projectId}`
      );
      expect(res.status).toBe(200);
      entry = (res.body.data as Array<Record<string, unknown>>).find((e) => {
        return e.orchestration_run_id === run.id;
      });
    }
    expect(entry).toMatchObject({
      kind: 'action_executed',
      ref_id: echoToolId,
      orchestration_run_id: run.id,
    });
  });
});

describe('a transform node whose expression throws', () => {
  test('a thrown object is recorded as its JSON', async () => {
    const orchestrationId = await createOrchestration({
      nodes: [{ id: 't', type: 'transform', expression: { throw: 'kaboom' } }],
    });

    const run = await runToRest(orchestrationId);

    expect(run.status).toBe('failed');
    expect(run.error).toEqual({
      code: 'UNKNOWN',
      message: '{"type":"kaboom"}',
    });
  });

  test('a thrown empty object is recorded by its string form', async () => {
    const orchestrationId = await createOrchestration({
      nodes: [
        {
          id: 't',
          type: 'transform',
          expression: { throw: [{ preserve: {} }] },
        },
      ],
    });

    const run = await runToRest(orchestrationId);

    expect(run.status).toBe('failed');
    expect(run.error).toEqual({ code: 'UNKNOWN', message: '[object Object]' });
  });
});

describe('a human node', () => {
  test('parks with the default prompt when the node names none', async () => {
    const orchestrationId = await createOrchestration({
      nodes: [{ id: 'ask', type: 'human' }],
    });

    const run = await runToRest(orchestrationId);

    expect(run.status).toBe('awaiting_input');
    expect(run.required_action?.prompt).toBe('Human input required.');
  });
});

describe('a node retry policy', () => {
  test('caps the attempts at 20 however many the node asks for', async () => {
    const orchestrationId = await createOrchestration({
      nodes: [
        {
          id: 'call',
          type: 'tool',
          tool_id: unavailableToolId,
          retry: { max_attempts: 999, backoff: { delay_ms: 0 } },
        },
      ],
    });

    const run = await runToRest(orchestrationId);

    expect(run.status).toBe('failed');
    expect(await executionsOf(run, 'call')).toHaveLength(20);
  });

  test('an exponential backoff doubles per attempt up to its cap', async () => {
    const orchestrationId = await createOrchestration({
      nodes: [
        {
          id: 'call',
          type: 'tool',
          tool_id: unavailableToolId,
          retry: {
            max_attempts: 3,
            backoff: {
              strategy: 'exponential',
              delay_ms: 1000,
              max_delay_ms: 1500,
            },
          },
        },
      ],
    });
    const runId = await startInBackground(orchestrationId);

    const expectWakeIn = async (args: {
      ms: number;
      drive: () => Promise<void>;
    }) => {
      const before = Date.now();
      await args.drive();
      const after = Date.now();
      const row = await runRow(runId);
      expect(row.status).toBe('sleeping');
      const wakeAt = row.wakeAt!.getTime();
      expect(wakeAt).toBeGreaterThanOrEqual(before + args.ms);
      expect(wakeAt).toBeLessThanOrEqual(after + args.ms);
    };

    await expectWakeIn({
      ms: 1000,
      drive: async () => {
        expect(await drainQueueOnce()).toBe(1);
      },
    });
    // 1000 × 2 would be 2000; the cap holds it at 1500.
    await expectWakeIn({
      ms: 1500,
      drive: () => {
        return wakeAndDrain(runId);
      },
    });

    const cancelled = await authenticatedTestClient(userToken).post(
      `/api/v1/orchestration-runs/${runId}/cancel`
    );
    expect(cancelled.status).toBe(200);
  });

  // The 502 says the fault came from upstream, not that it is transient: the
  // model answered, and it answers the same way on identical input.
  test('a schema violation is terminal despite its 502', async () => {
    const orchestrationId = await createOrchestration({
      nodes: [
        {
          id: 'ask',
          type: 'agent',
          agent_id: agentId,
          retry: { max_attempts: 3, backoff: { delay_ms: 0 } },
        },
      ],
    });
    mockCreateGeneration.mockRejectedValueOnce(
      new DomainError('OUTPUT_SCHEMA_VALIDATION_FAILED', 'answer off-schema')
    );

    const run = await runToRest(orchestrationId);

    expect(run.status).toBe('failed');
    expect(run.error?.code).toBe('OUTPUT_SCHEMA_VALIDATION_FAILED');
    expect(await executionsOf(run, 'ask')).toHaveLength(1);
  });

  test('a run woken onto a live graph that dropped the node fails naming it', async () => {
    const orchestrationId = await createOrchestration({
      nodes: [
        {
          id: 'call',
          type: 'tool',
          tool_id: unavailableToolId,
          retry: { max_attempts: 2, backoff: { delay_ms: 1000 } },
        },
      ],
    });
    const runId = await startInBackground(orchestrationId);
    expect(await drainQueueOnce()).toBe(1);
    expect((await getRun(runId)).status).toBe('sleeping');

    // A run with no pinned version executes the live graph, which an edit can
    // rewire while the run sleeps on its retry.
    await db.OrchestrationRun.update(
      { orchestrationVersion: null },
      { where: { publicId: runId } }
    );
    const patched = await authenticatedTestClient(userToken)
      .patch(`/api/v1/orchestrations/${orchestrationId}`)
      .send({ nodes: [{ id: 'other', type: 'transform', expression: 1 }] });
    expect(patched.status).toBe(200);

    await wakeAndDrain(runId);

    const run = await getRun(runId);
    expect(run.status).toBe('failed');
    expect(run.error).toEqual({
      code: 'ORCHESTRATION_NODE_FAILED',
      message: "Node 'call' not found in orchestration definition.",
    });
  });
});
