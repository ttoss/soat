import {
  type AdmissionService,
  ADMIT,
  DOWN_URL,
  PAYMENT_REFUSAL,
  REFUSAL,
  startAdmissionService,
} from '../../fixtures/admissionService';
import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { proposeCalls } from '../../fixtures/scriptedModel';
import { testClient } from '../../testClient';

let service: AdmissionService;
let turn: AgentToolTurn;
let agentId: string;
let firingPolicy: string;
let createTriggerTool: { id: string; name: string };
let createGenerationTool: { id: string; name: string };

const scheduleTrigger = (cron: unknown) => {
  return {
    name: `admitted-${Math.random().toString(36).slice(2)}`,
    type: 'schedule',
    target_type: 'agent',
    target_id: agentId,
    policy_ids: [firingPolicy],
    cron,
  };
};

const createOverRest = () => {
  return turn
    .api()
    .post('/api/v1/triggers')
    .send({ project_id: turn.projectId, ...scheduleTrigger('0 8 * * *') });
};

const generate = (body: Record<string, unknown>) => {
  return turn
    .api()
    .post(`/api/v1/agents/${agentId}/generate?wait=true`)
    .send(body);
};

/** One generation whose model makes `call`; its result and id. */
const callBuiltin = async (call: {
  name: string;
  args: Record<string, unknown>;
}) => {
  const res = await generate({ messages: [proposeCalls([call])] });
  expect(res.status).toBe(200);
  const [result] = JSON.parse(res.body.output?.content ?? '[]');
  return { result, generationId: res.body.id as string };
};

const createTriggerByBuiltin = () => {
  return callBuiltin({
    name: `${createTriggerTool.name}_create-trigger`,
    args: scheduleTrigger('0 8 * * *'),
  });
};

/** The refused call's answer, as the generation's transcript keeps it. */
const refusedCall = async (generationId: string) => {
  const res = await turn
    .api()
    .get(`/api/v1/generations/${generationId}/transcript`);
  expect(res.status).toBe(200);
  const [failed] = res.body.steps[0].tool_results;
  return {
    status: failed.error.meta.status,
    error: JSON.parse(failed.error.meta.body).error,
  };
};

/** A formation whose trigger's `cron` is only known once the deploy resolves it. */
const createByFormation = () => {
  return turn
    .api()
    .post('/api/v1/formations')
    .send({
      project_id: turn.projectId,
      name: `admission-${Math.random().toString(36).slice(2)}`,
      template: {
        parameters: { cron_expr: { type: 'string' } },
        resources: {
          Nightly: {
            type: 'trigger',
            properties: scheduleTrigger({ sub: '${cron_expr}' }),
          },
        },
      },
      parameters: { cron_expr: '0 3 * * *' },
    });
};

beforeAll(async () => {
  service = await startAdmissionService();
  turn = await startAgentToolTurn({ prefix: 'admission' });
  firingPolicy = await turn.createPolicy({
    statement: [{ effect: 'Allow', action: ['agents:CreateAgentGeneration'] }],
  });
  createTriggerTool = await turn.createTool({
    type: 'builtin',
    execute: undefined,
    parameters: undefined,
    actions: ['create-trigger'],
  });
  createGenerationTool = await turn.createTool({
    type: 'builtin',
    execute: undefined,
    parameters: undefined,
    actions: ['create-agent-generation'],
  });
  agentId = await turn.createAgent({
    tool_bindings: [
      { tool_id: createTriggerTool.id },
      { tool_id: createGenerationTool.id },
    ],
  });
});

beforeEach(() => {
  service.declare({ actions: ['triggers:CreateTrigger'] });
});

afterEach(() => {
  service.undeclare();
});

afterAll(async () => {
  await turn.close();
  await service.close();
});

describe('admission — a declared write is asked about before it executes', () => {
  describe('POST /api/v1/triggers', () => {
    test('passes when the service allows, asked once with the write it applies', async () => {
      const res = await createOverRest();

      expect(res.status).toBe(201);
      expect(service.asked).toHaveLength(1);
      expect(service.asked[0].signed).toBe(true);
      expect(service.asked[0].body).toMatchObject({
        action: 'triggers:CreateTrigger',
        project_id: turn.projectId,
        resource_type: 'trigger',
        resource_id: null,
        body: { cron: '0 8 * * *', target_id: agentId },
        principal: { type: 'user' },
      });
    });

    test('answers the refusal the service sent', async () => {
      service.reply = REFUSAL;

      const res = await createOverRest();

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PLAN_LIMIT_REACHED');
      expect(res.body.error.message).toBe('The plan allows 3 of these.');
      expect(res.body.error.meta).toEqual({ limit: 3 });
    });

    test('answers a refusal under its own status and lowercase code', async () => {
      service.reply = PAYMENT_REFUSAL;

      const res = await createOverRest();

      expect(res.status).toBe(402);
      expect(res.body.error.code).toBe('insufficient_credit');
      expect(res.body.error.meta).toEqual({ balance: 0 });
    });

    test.each([
      ['a code with a hyphen', 'insufficient-credit'],
      ['a code over 64 characters', `a${'_'.repeat(64)}`],
      ['an empty code', ''],
    ])('is a 502 for %s', async (_, code) => {
      service.reply = {
        status: 402,
        body: { error: { code, message: 'x' } },
      };

      const res = await createOverRest();

      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('ADMISSION_UNAVAILABLE');
    });

    test('is a 502 when the service is down', async () => {
      service.declare({ actions: ['triggers:CreateTrigger'], url: DOWN_URL });

      const res = await createOverRest();

      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('ADMISSION_UNAVAILABLE');
    });

    test('is a 502 when a refusal is outside the protocol', async () => {
      service.reply = {
        status: 500,
        body: { error: { code: 'X', message: 'x' } },
      };

      const res = await createOverRest();

      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('ADMISSION_UNAVAILABLE');
    });

    test('an undeclared action never calls the service', async () => {
      service.declare({ actions: ['triggers:UpdateTrigger'] });

      const res = await createOverRest();

      expect(res.status).toBe(201);
      expect(service.asked).toHaveLength(0);
    });

    test('an unauthenticated write is refused before the service is asked', async () => {
      const res = await testClient
        .post('/api/v1/triggers')
        .send({ project_id: turn.projectId, ...scheduleTrigger('0 8 * * *') });

      expect(res.status).toBe(401);
      expect(service.asked).toHaveLength(0);
    });
  });

  describe('PATCH /api/v1/triggers/{trigger_id}', () => {
    test('names the trigger the edit targets', async () => {
      const created = await createOverRest();
      expect(created.status).toBe(201);
      service.declare({ actions: ['triggers:UpdateTrigger'] });
      service.reply = REFUSAL;

      const res = await turn
        .api()
        .patch(`/api/v1/triggers/${created.body.id}`)
        .send({ name: 'renamed' });

      expect(res.body.error.code).toBe('PLAN_LIMIT_REACHED');
      expect(service.asked).toHaveLength(1);
      expect(service.asked[0].body).toMatchObject({
        action: 'triggers:UpdateTrigger',
        resource_id: created.body.id,
        body: { name: 'renamed' },
      });
    });
  });

  describe('POST /api/v1/projects — authorized by the admin gate', () => {
    test('is asked too', async () => {
      service.declare({ actions: ['projects:CreateProject'] });
      service.reply = REFUSAL;

      const res = await turn
        .api()
        .post('/api/v1/projects')
        .send({ name: 'admitted project' });

      expect(res.body.error.code).toBe('PLAN_LIMIT_REACHED');
      expect(service.asked).toHaveLength(1);
    });
  });

  describe('a builtin create-trigger in a generation', () => {
    test('passes when the service allows', async () => {
      const { result } = await createTriggerByBuiltin();

      expect(result.error).toBeUndefined();
      expect(result.id).toBeDefined();
      expect(service.asked).toHaveLength(1);
    });

    test('carries the refusal the service sent', async () => {
      service.reply = REFUSAL;

      const { generationId } = await createTriggerByBuiltin();

      const refused = await refusedCall(generationId);
      expect(refused.status).toBe(409);
      expect(refused.error.code).toBe('PLAN_LIMIT_REACHED');
    });

    test('carries a refusal under its own status and lowercase code', async () => {
      service.reply = PAYMENT_REFUSAL;

      const { generationId } = await createTriggerByBuiltin();

      const refused = await refusedCall(generationId);
      expect(refused.status).toBe(402);
      expect(refused.error.code).toBe('insufficient_credit');
      expect(refused.error.meta).toEqual({ balance: 0 });
    });

    test('is ADMISSION_UNAVAILABLE when the service is down', async () => {
      service.declare({ actions: ['triggers:CreateTrigger'], url: DOWN_URL });

      const { generationId } = await createTriggerByBuiltin();

      const refused = await refusedCall(generationId);
      expect(refused.status).toBe(502);
      expect(refused.error.code).toBe('ADMISSION_UNAVAILABLE');
    });
  });

  describe('a formation declaring a trigger', () => {
    test('passes when the service allows, asked with the resolved cron', async () => {
      const res = await createByFormation();

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('active');
      expect(service.asked).toHaveLength(1);
      expect(service.asked[0].body).toMatchObject({
        action: 'triggers:CreateTrigger',
        project_id: turn.projectId,
        resource_type: 'trigger',
        body: { cron: '0 3 * * *' },
      });
    });

    test('fails the deploy with the refusal the service sent', async () => {
      service.reply = REFUSAL;

      const res = await createByFormation();

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('failed');
      expect(res.body.error.code).toBe('PLAN_LIMIT_REACHED');
    });

    test('fails the deploy with a lowercase code the service sent', async () => {
      service.reply = PAYMENT_REFUSAL;

      const res = await createByFormation();

      expect(res.body.status).toBe('failed');
      expect(res.body.error.code).toBe('insufficient_credit');
      expect(res.body.error.meta).toMatchObject({ balance: 0 });
    });

    test('fails the deploy with ADMISSION_UNAVAILABLE when the service is down', async () => {
      service.declare({ actions: ['triggers:CreateTrigger'], url: DOWN_URL });

      const res = await createByFormation();

      expect(res.body.status).toBe('failed');
      expect(res.body.error.code).toBe('ADMISSION_UNAVAILABLE');
    });
  });

  describe('a start: POST /api/v1/agents/{agent_id}/generate', () => {
    const hello = { messages: [{ role: 'user', content: 'hello' }] };

    beforeEach(() => {
      service.declare({ actions: ['agents:CreateAgentGeneration'] });
    });

    test('passes when the service allows, asked once for the run', async () => {
      const res = await generate(hello);

      expect(res.status).toBe(200);
      expect(service.asked).toHaveLength(1);
      expect(service.asked[0].body).toMatchObject({
        action: 'agents:CreateAgentGeneration',
        project_id: turn.projectId,
        resource_id: agentId,
      });
    });

    test('answers the refusal the service sent', async () => {
      service.reply = REFUSAL;

      const res = await generate(hello);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PLAN_LIMIT_REACHED');
    });

    test('answers a 402 refusal with its lowercase code and meta', async () => {
      service.reply = PAYMENT_REFUSAL;

      const res = await generate(hello);

      expect(res.status).toBe(402);
      expect(res.body.error.code).toBe('insufficient_credit');
      expect(res.body.error.message).toBe('The account has no credit left.');
      expect(res.body.error.meta).toEqual({ balance: 0 });
    });

    test('streamed, refuses before the stream opens', async () => {
      service.reply = REFUSAL;

      const res = await generate({ ...hello, stream: true });

      expect(res.status).toBe(409);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.body.error.code).toBe('PLAN_LIMIT_REACHED');
    });

    test('streamed, opens when the service allows', async () => {
      const res = await generate({ ...hello, stream: true });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
      expect(service.asked).toHaveLength(1);
    });

    test('is a 502 when the service is down', async () => {
      service.declare({
        actions: ['agents:CreateAgentGeneration'],
        url: DOWN_URL,
      });

      const res = await generate(hello);

      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('ADMISSION_UNAVAILABLE');
    });

    test('a builtin create-agent-generation is asked as its own start', async () => {
      // The outer start is admitted; the one its builtin call makes is refused.
      service.reply = (index) => {
        return index === 0 ? ADMIT : REFUSAL;
      };

      const res = await generate({
        messages: [
          proposeCalls([
            {
              name: `${createGenerationTool.name}_create-agent-generation`,
              args: { agent_id: agentId, messages: hello.messages },
            },
          ]),
        ],
      });

      expect(res.status).toBe(200);
      expect(service.asked).toHaveLength(2);
      const [result] = JSON.parse(res.body.output?.content ?? '[]');
      expect(result.id).toBeUndefined();
      const refused = await refusedCall(res.body.id);
      expect(refused.error.code).toBe('PLAN_LIMIT_REACHED');
    });
  });
});
