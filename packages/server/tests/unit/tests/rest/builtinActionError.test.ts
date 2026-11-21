import {
  type AdmissionService,
  type Reply,
  startAdmissionService,
} from '../../fixtures/admissionService';
import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { nodeExecutionsOf } from '../../fixtures/nodeExecutions';
import { authenticatedTestClient, loginAs } from '../../testClient';

/**
 * A native builtin action's error is relayed as its REST call answers it: the
 * same status, code, message and `meta`, to a direct call and, as the REST
 * error body, to an agent's tool result.
 */
const PLAN_CAP: Reply = {
  status: 403,
  body: {
    error: {
      code: 'PLAN_LIMIT_REACHED',
      message: 'The plan allows 3 of these.',
      meta: { limit: 3 },
    },
  },
};

let service: AdmissionService;
let turn: AgentToolTurn;
let agentId: string;
let firingPolicy: string;
let toolId: string;
let toolName: string;
let userToken: string;
let deniedAgentId: string;

const trigger = (args: { name?: string; cron?: string } = {}) => {
  return {
    name: args.name ?? turn.unique('relayed-trigger'),
    type: 'schedule',
    target_type: 'agent',
    target_id: agentId,
    policy_ids: [firingPolicy],
    cron: args.cron ?? '0 8 * * *',
  };
};

/** An input the operation's schema refuses. */
const invalidTrigger = () => {
  return { ...trigger(), cron: 42 };
};

/** A trigger whose name is taken, so creating it again is `409`. */
const takenTrigger = async () => {
  const taken = trigger();
  const res = await turn
    .api()
    .post('/api/v1/triggers')
    .send({ project_id: turn.projectId, ...taken });
  expect(res.status).toBe(201);
  return taken;
};

const callDirect = (args: {
  token?: string;
  input: Record<string, unknown>;
}) => {
  return authenticatedTestClient(args.token ?? turn.adminToken)
    .post(`/api/v1/tools/${toolId}/call`)
    .send({
      action: 'create-trigger',
      input: { project_id: turn.projectId, ...args.input },
    });
};

/** What the model read for its one call, and how the call ended. */
const inTurn = async (args: {
  agentId?: string;
  input: Record<string, unknown>;
}) => {
  const { id, results } = await turn.generate({
    agentId: args.agentId ?? agentId,
    calls: [{ name: `${toolName}_create-trigger`, args: args.input }],
  });
  const progress = await turn.api().get(`/api/v1/generations/${id}/events`);
  return { result: results[0], progress };
};

beforeAll(async () => {
  turn = await startAgentToolTurn({ prefix: 'builtinerr' });
  firingPolicy = await turn.createPolicy({
    statement: [{ effect: 'Allow', action: ['agents:CreateAgentGeneration'] }],
  });
  const tool = await turn.createTool({
    type: 'builtin',
    execute: undefined,
    parameters: undefined,
    actions: ['create-trigger'],
  });
  toolId = tool.id;
  toolName = tool.name;
  agentId = await turn.createAgent({ tool_bindings: [{ tool_id: toolId }] });
  deniedAgentId = await turn.createAgent({
    tool_bindings: [{ tool_id: toolId }],
    policy_ids: [
      await turn.createPolicy({
        statement: [
          { effect: 'Deny', action: ['triggers:CreateTrigger'] },
          { effect: 'Allow', action: ['tools:CallTool'] },
        ],
      }),
    ],
  });

  const user = await turn
    .api()
    .post('/api/v1/users')
    .send({ username: 'builtinerrcaller', password: 'builtinerrpass' });
  expect(user.status).toBe(201);
  const policy = await turn.createPolicy({
    statement: [
      {
        effect: 'Allow',
        action: ['tools:CallTool', 'tools:GetTool'],
        resource: [`srn:${turn.projectId}:*:*`],
      },
    ],
  });
  const attach = await turn
    .api()
    .put(`/api/v1/users/${user.body.id}/policies`)
    .send({ policy_ids: [policy] });
  expect(attach.status).toBe(204);
  userToken = await loginAs('builtinerrcaller', 'builtinerrpass');
  service = await startAdmissionService();
});

afterEach(() => {
  service.undeclare();
});

afterAll(async () => {
  await turn.close();
  await service.close();
});

describe('POST /api/v1/tools/{tool_id}/call — a failed native action', () => {
  test('VALIDATION_FAILED is relayed with its status and meta', async () => {
    const input = invalidTrigger();
    const rest = await turn
      .api()
      .post('/api/v1/triggers')
      .send({ project_id: turn.projectId, ...input });

    const res = await callDirect({ input });

    expect(rest.status).toBe(400);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.meta).toEqual(rest.body.error.meta);
  });

  test('a 409 is relayed with its code and meta', async () => {
    const taken = await takenTrigger();

    const res = await callDirect({ input: taken });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NAME_CONFLICT');
    expect(res.body.error.meta).toEqual({ name: taken.name });
  });

  test('FORBIDDEN is relayed with the denial meta', async () => {
    const res = await callDirect({ token: userToken, input: trigger() });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.meta).toMatchObject({
      action: 'triggers:CreateTrigger',
      denied_by: { type: 'user' },
    });
  });

  test('a code this API does not define keeps its own status and code', async () => {
    service.declare({ actions: ['triggers:CreateTrigger'] });
    service.reply = PLAN_CAP;

    const res = await callDirect({ input: trigger() });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({
      code: 'PLAN_LIMIT_REACHED',
      message: 'The plan allows 3 of these.',
      meta: { limit: 3 },
    });
  });
});

describe('a failed native action in an agent turn', () => {
  test('VALIDATION_FAILED is the tool result, the call failed', async () => {
    const { result, progress } = await inTurn({ input: invalidTrigger() });

    expect(result).toMatchObject({
      status: 400,
      error: { code: 'VALIDATION_FAILED', meta: expect.any(Object) },
    });
    expect(JSON.stringify(progress.body)).toMatch(/"status":"failed"/);
  });

  test('a 409 is the tool result with its code and meta', async () => {
    const taken = await takenTrigger();

    const { result } = await inTurn({ input: taken });

    expect(result).toMatchObject({
      status: 409,
      error: { code: 'NAME_CONFLICT', meta: { name: taken.name } },
    });
  });

  test('FORBIDDEN is the tool result with the denial meta', async () => {
    const { result } = await inTurn({
      agentId: deniedAgentId,
      input: trigger(),
    });

    expect(result).toMatchObject({
      status: 403,
      error: {
        code: 'FORBIDDEN',
        meta: {
          action: 'triggers:CreateTrigger',
          denied_by: { type: 'agent', id: deniedAgentId },
        },
      },
    });
  });
});

describe('an orchestration step on a failed native action', () => {
  const attemptsOf = async (input: Record<string, unknown>) => {
    const orchestration = await turn
      .api()
      .post('/api/v1/orchestrations')
      .send({
        project_id: turn.projectId,
        name: turn.unique('relayed-run'),
        nodes: [
          {
            id: 'call',
            type: 'tool',
            tool_id: toolId,
            operation_id: 'create-trigger',
            input_mapping: { project_id: turn.projectId, ...input },
            retry: { max_attempts: 3, backoff: { delay_ms: 0 } },
          },
        ],
        edges: [],
      });
    expect(orchestration.status).toBe(201);
    const start = await turn
      .api()
      .post('/api/v1/orchestration-runs')
      .send({ wait: true, orchestration_id: orchestration.body.id });
    expect(start.status).toBe(201);
    expect(start.body.status).toBe('failed');
    const rows = await nodeExecutionsOf({
      token: turn.adminToken,
      runId: start.body.id,
    });
    return { error: start.body.error, attempts: rows.length };
  };

  test('a relayed 4xx is not retried', async () => {
    const taken = await takenTrigger();

    const { error, attempts } = await attemptsOf(taken);

    expect(error.code).toBe('NAME_CONFLICT');
    expect(attempts).toBe(1);
  });

  test('a relayed 5xx is retried', async () => {
    service.declare({ actions: ['triggers:CreateTrigger'] });
    service.reply = { status: 500, body: null };

    const { error, attempts } = await attemptsOf(trigger());

    expect(error.code).toBe('ADMISSION_UNAVAILABLE');
    expect(attempts).toBe(3);
  });
});
