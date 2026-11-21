import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import { proposeCalls } from '../../fixtures/scriptedModel';
import { authenticatedTestClient } from '../../testClient';

const EVERY_FIVE_MINUTES = '*/5 * * * *';
const HOURLY = '0 * * * *';
const FLOOR = 3600;
const REFUSAL_META = {
  min_trigger_interval_seconds: FLOOR,
  interval_seconds: 300,
};

let turn: AgentToolTurn;
let agentId: string;
let firingPolicy: string;
let createTriggerTool: { id: string; name: string };

const scheduleTrigger = (cron: unknown) => {
  return {
    name: `floored-${Math.random().toString(36).slice(2)}`,
    type: 'schedule',
    target_type: 'agent',
    target_id: agentId,
    policy_ids: [firingPolicy],
    cron,
  };
};

const createOverRest = (cron: string) => {
  return turn
    .api()
    .post('/api/v1/triggers')
    .send({ project_id: turn.projectId, ...scheduleTrigger(cron) });
};

const setFloor = (floor: number | null) => {
  return turn
    .api()
    .patch(`/api/v1/projects/${turn.projectId}`)
    .send({ min_trigger_interval_seconds: floor });
};

beforeAll(async () => {
  turn = await startAgentToolTurn({ prefix: 'trigfloor' });
  firingPolicy = await turn.createPolicy({
    statement: [{ effect: 'Allow', action: ['agents:CreateAgentGeneration'] }],
  });
  createTriggerTool = await turn.createTool({
    type: 'builtin',
    execute: undefined,
    parameters: undefined,
    actions: ['create-trigger'],
  });
  agentId = await turn.createAgent({
    tool_bindings: [{ tool_id: createTriggerTool.id }],
  });
});

afterAll(async () => {
  await turn.close();
});

describe('min_trigger_interval_seconds', () => {
  test('defaults to null', async () => {
    const res = await turn.api().get(`/api/v1/projects/${turn.projectId}`);
    expect(res.status).toBe(200);
    expect(res.body.min_trigger_interval_seconds).toBeNull();
  });

  test.each([0, -1, 1.5, '3600'])('rejects %p with 400', async (value) => {
    const res = await turn
      .api()
      .patch(`/api/v1/projects/${turn.projectId}`)
      .send({ min_trigger_interval_seconds: value });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  test('a caller allowed to update the project but not its admin gets 403', async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'trigfloorperm',
      policyActions: ['projects:UpdateProject', 'projects:GetProject'],
    });
    const res = await authenticatedTestClient(setup.userToken)
      .patch(`/api/v1/projects/${setup.projectId}`)
      .send({ min_trigger_interval_seconds: FLOOR });
    expect(res.status).toBe(403);

    const allowed = await authenticatedTestClient(setup.userToken)
      .patch(`/api/v1/projects/${setup.projectId}`)
      .send({ name: 'renamed-by-member' });
    expect(allowed.status).toBe(200);
    expect(allowed.body.min_trigger_interval_seconds).toBeNull();
  });
});

describe('a project floor on schedule triggers', () => {
  let belowFloorId: string;

  beforeAll(async () => {
    const created = await createOverRest(EVERY_FIVE_MINUTES);
    expect(created.status).toBe(201);
    belowFloorId = created.body.id;

    const res = await setFloor(FLOOR);
    expect(res.status).toBe(200);
    expect(res.body.min_trigger_interval_seconds).toBe(FLOOR);
  });

  test('refuses a create over REST below the floor', async () => {
    const res = await createOverRest(EVERY_FIVE_MINUTES);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TRIGGER_INTERVAL_BELOW_FLOOR');
    expect(res.body.error.meta).toMatchObject(REFUSAL_META);
  });

  test('creates an hourly trigger', async () => {
    const res = await createOverRest(HOURLY);
    expect(res.status).toBe(201);
  });

  test('measures the tightest pair, not the first', async () => {
    const res = await createOverRest('0,10 9 * * *');
    expect(res.status).toBe(400);
    expect(res.body.error.meta).toMatchObject({ interval_seconds: 600 });
  });

  test('an existing trigger below the floor is refused at its next update', async () => {
    const got = await turn.api().get(`/api/v1/triggers/${belowFloorId}`);
    expect(got.status).toBe(200);

    const res = await turn
      .api()
      .patch(`/api/v1/triggers/${belowFloorId}`)
      .send({ description: 'touched' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TRIGGER_INTERVAL_BELOW_FLOOR');

    const raised = await turn
      .api()
      .patch(`/api/v1/triggers/${belowFloorId}`)
      .send({ cron: HOURLY });
    expect(raised.status).toBe(200);
  });

  test('refuses a builtin create-trigger below the floor', async () => {
    const res = await turn
      .api()
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({
        messages: [
          proposeCalls([
            {
              name: `${createTriggerTool.name}_create-trigger`,
              args: scheduleTrigger(EVERY_FIVE_MINUTES),
            },
          ]),
        ],
      });
    expect(res.status).toBe(200);
    const transcript = await turn
      .api()
      .get(`/api/v1/generations/${res.body.id}/transcript`);
    const [failed] = transcript.body.steps[0].tool_results;
    expect(failed.result.status).toBe(400);
    expect(failed.result.error.code).toBe('TRIGGER_INTERVAL_BELOW_FLOOR');
    expect(failed.result.error.meta).toMatchObject(REFUSAL_META);
  });

  test("refuses a formation's resolved cron below the floor", async () => {
    const res = await turn
      .api()
      .post('/api/v1/formations')
      .send({
        project_id: turn.projectId,
        name: `trigfloor-${Math.random().toString(36).slice(2)}`,
        template: {
          parameters: { cron_expr: { type: 'string' } },
          resources: {
            Frequent: {
              type: 'trigger',
              properties: scheduleTrigger({ sub: '${cron_expr}' }),
            },
          },
        },
        parameters: { cron_expr: EVERY_FIVE_MINUTES },
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('failed');
    expect(res.body.error.code).toBe('TRIGGER_INTERVAL_BELOW_FLOOR');
    expect(res.body.error.meta).toMatchObject(REFUSAL_META);
  });

  test('clearing the floor admits the cron again', async () => {
    expect((await setFloor(null)).status).toBe(200);
    const res = await createOverRest(EVERY_FIVE_MINUTES);
    expect(res.status).toBe(201);
  });
});
