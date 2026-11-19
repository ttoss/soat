import {
  type AdmissionService,
  type Reply,
  startAdmissionService,
} from '../../fixtures/admissionService';
import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { proposeCalls } from '../../fixtures/scriptedModel';

/**
 * A refused builtin action reaches the model as text, which is all the agent
 * reads to tell a plan cap from a bad field: it carries the target's status,
 * code and message, and names neither the product nor a route path.
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

// The product name, a route path, or a hint or docs link leaking into a text.
const LEAK = /soat|\/api\/v1|docs_url|"hint"/i;

let service: AdmissionService;
let turn: AgentToolTurn;
let agentId: string;
let firingPolicy: string;
let toolId: string;
let toolName: string;

const trigger = (cron: string) => {
  return {
    name: turn.unique('refused-trigger'),
    type: 'schedule',
    target_type: 'agent',
    target_id: agentId,
    policy_ids: [firingPolicy],
    cron,
  };
};

/** The model-visible text of the refused call and the transcript's error. */
const refusedInGeneration = async (cron: string) => {
  const res = await turn
    .api()
    .post(`/api/v1/agents/${agentId}/generate?wait=true`)
    .send({
      messages: [
        proposeCalls([
          { name: `${toolName}_create-trigger`, args: trigger(cron) },
        ]),
      ],
    });
  expect(res.status).toBe(200);
  const [seen] = JSON.parse(res.body.output.content) as unknown[];
  const transcript = await turn
    .api()
    .get(`/api/v1/generations/${res.body.id}/transcript`);
  expect(transcript.status).toBe(200);
  const [failed] = transcript.body.steps[0].tool_results;
  return { seen, error: failed.error };
};

beforeAll(async () => {
  service = await startAdmissionService();
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
});

afterEach(() => {
  service.undeclare();
});

afterAll(async () => {
  await turn.close();
  await service.close();
});

describe('a refused builtin action in a generation', () => {
  test('a 403 shows the model its status, code and message', async () => {
    service.declare({ actions: ['triggers:CreateTrigger'] });
    service.reply = PLAN_CAP;

    const { seen, error } = await refusedInGeneration('0 8 * * *');

    expect(seen).toBe(
      "DomainError: Builtin action 'create-trigger' failed: HTTP 403 PLAN_LIMIT_REACHED: The plan allows 3 of these."
    );
    expect(error.code).toBe('TOOL_HTTP_ERROR');
    expect(error.meta).toMatchObject({
      tool_status_code: 403,
      tool_action: 'create-trigger',
      tool_method: 'POST',
      tool_error: {
        code: 'PLAN_LIMIT_REACHED',
        message: 'The plan allows 3 of these.',
        meta: { limit: 3 },
      },
    });
  });

  test('a 400 shows the model its status and code', async () => {
    const { seen, error } = await refusedInGeneration('not a cron');

    expect(seen).toBe(
      "DomainError: Builtin action 'create-trigger' failed: HTTP 400 INVALID_CRON_EXPRESSION: A trigger cron expression must have exactly 5 fields (UTC)."
    );
    expect(error.meta.tool_status_code).toBe(400);
    expect(error.meta.tool_error.code).toBe('INVALID_CRON_EXPRESSION');
  });

  test('neither the text nor the stored error names the product or a path', async () => {
    service.declare({ actions: ['triggers:CreateTrigger'] });
    service.reply = PLAN_CAP;

    const { seen, error } = await refusedInGeneration('0 8 * * *');

    expect(seen).not.toMatch(LEAK);
    const { tool_error: relayed, ...meta } = error.meta;
    expect(JSON.stringify([error.message, meta, relayed.message])).not.toMatch(
      LEAK
    );
  });
});

describe('POST /api/v1/tools/{tool_id}/call — a refused builtin action', () => {
  test('is 502 TOOL_HTTP_ERROR carrying the status and the error', async () => {
    service.declare({ actions: ['triggers:CreateTrigger'] });
    service.reply = PLAN_CAP;

    const res = await turn
      .api()
      .post(`/api/v1/tools/${toolId}/call`)
      .send({
        action: 'create-trigger',
        input: { project_id: turn.projectId, ...trigger('0 8 * * *') },
      });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('TOOL_HTTP_ERROR');
    expect(res.body.error.message).toBe(
      "Builtin action 'create-trigger' failed: HTTP 403 PLAN_LIMIT_REACHED: The plan allows 3 of these."
    );
    expect(res.body.error.meta.tool_status_code).toBe(403);
    expect(res.body.error.meta.tool_error.code).toBe('PLAN_LIMIT_REACHED');
    expect(res.body.error.meta.tool_url).toBeUndefined();
  });
});

describe('POST /api/v1/tools — an action that cannot be bound', () => {
  test.each([
    ['unknown', ['no-such-action']],
    ['withheld from agents', ['create-api-key']],
  ])('the %s refusal names no product', async (_label, actions) => {
    const res = await turn
      .api()
      .post('/api/v1/tools')
      .send({
        project_id: turn.projectId,
        name: turn.unique('unbindable'),
        type: 'builtin',
        actions,
      });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/builtin action/i);
    expect(res.body.error.message).not.toMatch(LEAK);
  });
});
