import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { proposeCalls } from '../../fixtures/scriptedModel';

/**
 * A key under the deployment's reserved prefix belongs to an IAM token's layer
 * alone: every other carrier refuses it with `INVALID_TOOL_CONTEXT_KEY`, per
 * request, through a `builtin` action, and in a formation template.
 */

const PREFIX_ENV = 'SOAT_RESERVED_TOOL_CONTEXT_PREFIX';
const RESERVED = { Plat_Tenant: 'forged' };

const expectRefused = (res: {
  status: number;
  body: { error?: { code?: string; meta?: { keys?: string[] } } };
}) => {
  expect(res.status).toBe(400);
  expect(res.body.error?.code).toBe('INVALID_TOOL_CONTEXT_KEY');
  expect(res.body.error?.meta?.keys).toEqual(['Plat_Tenant']);
};

describe('a reserved-prefix tool_context key', () => {
  let turn: AgentToolTurn;
  let agentId: string;
  let sessionId: string;
  let triggerId: string;
  let generationTool: { id: string; name: string };
  let relayAgentId: string;
  let previousPrefix: string | undefined;

  beforeAll(async () => {
    previousPrefix = process.env[PREFIX_ENV];
    process.env[PREFIX_ENV] = 'plat_';
    turn = await startAgentToolTurn({ prefix: 'rsvtcx' });
    agentId = await turn.createAgent({});
    generationTool = await turn.createTool({
      type: 'builtin',
      execute: undefined,
      parameters: undefined,
      actions: ['create-agent-generation'],
    });
    relayAgentId = await turn.createAgent({
      tool_bindings: [{ tool_id: generationTool.id }],
    });

    const session = await turn
      .api()
      .post('/api/v1/sessions')
      .send({ agent_id: agentId });
    expect(session.status).toBe(201);
    sessionId = session.body.id;

    const policyId = await turn.createPolicy({
      statement: [
        { effect: 'Allow', action: ['agents:CreateAgentGeneration'] },
      ],
    });
    const trigger = await turn
      .api()
      .post('/api/v1/triggers')
      .send({
        project_id: turn.projectId,
        policy_ids: [policyId],
        name: turn.unique('trigger'),
        type: 'manual',
        target_type: 'agent',
        target_id: agentId,
      });
    expect(trigger.status).toBe(201);
    triggerId = trigger.body.id;
  });

  afterAll(async () => {
    if (previousPrefix === undefined) delete process.env[PREFIX_ENV];
    else process.env[PREFIX_ENV] = previousPrefix;
    await turn.close();
  });

  describe('on a per-request carrier', () => {
    test('POST /agents/:agent_id/generate is 400', async () => {
      const res = await turn
        .api()
        .post(`/api/v1/agents/${agentId}/generate?wait=true`)
        .send({
          messages: [{ role: 'user', content: 'hi' }],
          tool_context: RESERVED,
        });

      expectRefused(res);
    });

    test('POST /sessions/:session_id/generate is 400', async () => {
      const res = await turn
        .api()
        .post(`/api/v1/sessions/${sessionId}/generate`)
        .send({ tool_context: RESERVED });

      expectRefused(res);
    });

    test('POST /sessions/:session_id/messages is 400', async () => {
      const res = await turn
        .api()
        .post(`/api/v1/sessions/${sessionId}/messages`)
        .send({ message: 'hi', tool_context: RESERVED });

      expectRefused(res);
    });

    test('POST /triggers/:trigger_id/fire is 400', async () => {
      const res = await turn
        .api()
        .post(`/api/v1/triggers/${triggerId}/fire`)
        .send({ input: { message: 'hi' }, tool_context: RESERVED });

      expectRefused(res);
    });

    test('an unreserved key is accepted', async () => {
      const res = await turn
        .api()
        .post(`/api/v1/triggers/${triggerId}/fire`)
        .send({ input: { message: 'hi' }, tool_context: { tenant: 'acct_1' } });

      expect(res.status).toBe(200);
    });
  });

  test('a builtin action sending one is refused', async () => {
    const res = await turn
      .api()
      .post(`/api/v1/agents/${relayAgentId}/generate?wait=true`)
      .send({
        messages: [
          proposeCalls([
            {
              name: `${generationTool.name}_create-agent-generation`,
              args: {
                agent_id: agentId,
                messages: [{ role: 'user', content: 'hi' }],
                tool_context: RESERVED,
              },
            },
          ]),
        ],
      });

    expect(res.status).toBe(200);
    const transcript = await turn
      .api()
      .get(`/api/v1/generations/${res.body.id}/transcript`);
    expect(transcript.status).toBe(200);
    const [failed] = transcript.body.steps[0].tool_results;
    expect(failed.result.status).toBe(400);
    expect(failed.result.error.code).toBe('INVALID_TOOL_CONTEXT_KEY');
  });

  describe('in a formation template', () => {
    const sessionTemplate = {
      resources: {
        MySession: {
          type: 'session',
          properties: { agent_id: 'agt_unknown', tool_context: RESERVED },
        },
      },
    };

    const loopTemplate = {
      resources: {
        MyOrchestration: {
          type: 'orchestration',
          properties: {
            name: 'reserved-loop',
            nodes: [
              {
                id: 'each',
                type: 'loop',
                items: { var: 'input.items' },
                item_tool_context: { Plat_Tenant: { var: 'item' } },
              },
            ],
            edges: [],
          },
        },
      },
    };

    test('validate refuses a resource bag', async () => {
      const res = await turn
        .api()
        .post('/api/v1/formations/validate')
        .send({ template: sessionTemplate });

      expectRefused(res);
    });

    test('validate refuses a graph node bag at depth', async () => {
      const res = await turn
        .api()
        .post('/api/v1/formations/validate')
        .send({ template: loopTemplate });

      expectRefused(res);
    });

    test('plan refuses it', async () => {
      const res = await turn
        .api()
        .post('/api/v1/formations/plan')
        .send({ project_id: turn.projectId, template: loopTemplate });

      expectRefused(res);
    });

    test('create refuses it', async () => {
      const res = await turn
        .api()
        .post('/api/v1/formations')
        .send({
          project_id: turn.projectId,
          name: turn.unique('formation'),
          template: sessionTemplate,
        });

      expectRefused(res);
    });
  });
});
