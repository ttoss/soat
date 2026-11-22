import { declareDenialCodes, parseDenialCodes } from 'src/errors';

import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { proposeCalls } from '../../fixtures/scriptedModel';
import { authenticatedTestClient, loginAs } from '../../testClient';

// A deployment's policy answers a denial with its own declared code, on every
// path the authorization check runs.

const CODE = 'PLAN_FEATURE_NOT_INCLUDED';
const HINT = 'Upgrade the plan to one that includes the feature.';
const DENIAL = {
  code: CODE,
  message: 'Guardrails are not included in this plan.',
  meta: { feature: 'guardrails' },
};

const DENY_GUARDRAILS = {
  effect: 'Deny',
  action: ['guardrails:*'],
  denial: DENIAL,
};

describe('a policy denial', () => {
  let turn: AgentToolTurn;
  let key: string;
  let keyId: string;
  let userToken: string;

  const mcpCall = (name: string, args: Record<string, unknown>) => {
    return authenticatedTestClient(key)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'call', arguments: { name, arguments: args } },
      });
  };

  const expectDenial = (error: Record<string, unknown>) => {
    expect(error).toMatchObject({
      code: CODE,
      message: DENIAL.message,
      hint: HINT,
      meta: {
        feature: 'guardrails',
        denied_by: { type: 'api_key', id: keyId },
      },
    });
  };

  beforeAll(async () => {
    declareDenialCodes({
      codes: parseDenialCodes({
        config: { denial_codes: [{ code: CODE, hint: HINT }] },
        source: 'test',
      }),
    });
    turn = await startAgentToolTurn({ prefix: 'poldenial' });
    const policy = await turn.createPolicy({
      statement: [{ effect: 'Allow', action: ['*'] }, DENY_GUARDRAILS],
    });
    const minted = await turn
      .api()
      .post('/api/v1/api-keys')
      .send({
        name: 'plan key',
        project_id: turn.projectId,
        policy_ids: [policy],
      });
    expect(minted.status).toBe(201);
    key = minted.body.key;
    keyId = minted.body.id;
    const user = await turn
      .api()
      .post('/api/v1/users')
      .send({ username: 'poldenialwriter', password: 'poldenialpass' });
    expect(user.status).toBe(201);
    const allowAll = await turn.createPolicy({
      statement: [{ effect: 'Allow', action: ['*'] }],
    });
    const attach = await turn
      .api()
      .put(`/api/v1/users/${user.body.id}/policies`)
      .send({ policy_ids: [allowAll] });
    expect(attach.status).toBe(204);
    userToken = await loginAs('poldenialwriter', 'poldenialpass');
  });

  afterAll(async () => {
    declareDenialCodes({ codes: new Map() });
    await turn.close();
  });

  describe('answers the declared code', () => {
    test('on a REST read', async () => {
      const res = await authenticatedTestClient(key).get(
        `/api/v1/guardrails?project_id=${turn.projectId}`
      );

      expect(res.status).toBe(403);
      expectDenial(res.body.error);
      expect(res.body.error.meta.action).toBe('guardrails:ListGuardrails');
    });

    test('on a REST write', async () => {
      const res = await authenticatedTestClient(key)
        .post('/api/v1/guardrails')
        .send({
          project_id: turn.projectId,
          name: 'denied',
          document: { class: 'A' },
        });

      expect(res.status).toBe(403);
      expectDenial(res.body.error);
    });

    test('on a read of one guardrail', async () => {
      const guardrailId = await turn.createGuardrail({ class: 'A' });

      const res = await authenticatedTestClient(key).get(
        `/api/v1/guardrails/${guardrailId}`
      );

      expect(res.status).toBe(403);
      expectDenial(res.body.error);
    });

    test('on /mcp', async () => {
      const res = await mcpCall('list-guardrails', {
        project_id: turn.projectId,
      });

      expect(res.body.result.isError).toBe(true);
      expect(res.body.result.structuredContent.status).toBe(403);
      expectDenial(res.body.result.structuredContent.error);
    });

    test('on a formation', async () => {
      const res = await authenticatedTestClient(key)
        .post('/api/v1/formations')
        .send({
          project_id: turn.projectId,
          name: 'denied-stack',
          template: {
            resources: {
              MyGuardrail: {
                type: 'guardrail',
                properties: { name: 'denied-guardrail', class: 'A' },
              },
            },
          },
        });

      expect(res.status).toBe(403);
      expectDenial(res.body.error);
    });

    test('on a builtin call in a turn', async () => {
      const tool = await turn.createTool({
        type: 'builtin',
        execute: undefined,
        parameters: undefined,
        actions: ['list-guardrails'],
      });
      const agentId = await turn.createAgent({
        tool_bindings: [{ tool_id: tool.id }],
      });

      const res = await authenticatedTestClient(key)
        .post(`/api/v1/agents/${agentId}/generate?wait=true`)
        .send({
          messages: [
            proposeCalls([
              {
                name: `${tool.name}_list-guardrails`,
                args: { project_id: turn.projectId },
              },
            ]),
          ],
        });

      expect(res.status).toBe(200);
      const [result] = JSON.parse(res.body.output.content);
      expect(result.error).toMatchObject({
        code: CODE,
        message: DENIAL.message,
        meta: { feature: 'guardrails' },
      });
    });
  });

  describe('answers the declared code to a writer whose resource would perform the action', () => {
    const builtinTool = { type: 'builtin', actions: ['create-guardrail'] };

    test('on a tool write', async () => {
      const res = await authenticatedTestClient(key)
        .post('/api/v1/tools')
        .send({
          project_id: turn.projectId,
          name: 'denied-tool',
          ...builtinTool,
        });

      expect(res.status).toBe(403);
      expectDenial(res.body.error);
      expect(res.body.error.meta.action).toBe('guardrails:CreateGuardrail');
    });

    test('on a formation tool resource', async () => {
      const res = await authenticatedTestClient(key)
        .post('/api/v1/formations')
        .send({
          project_id: turn.projectId,
          name: 'denied-tool-stack',
          template: {
            resources: {
              Tool: {
                type: 'tool',
                properties: { name: 'denied-stack-tool', ...builtinTool },
              },
            },
          },
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('failed');
      expect(JSON.stringify(res.body)).toContain(CODE);
      expect(JSON.stringify(res.body)).not.toContain('ACTION_NOT_HELD');
    });
  });

  test('a Deny with no denial still answers FORBIDDEN', async () => {
    const policy = await turn.createPolicy({
      statement: [
        { effect: 'Allow', action: ['*'] },
        { effect: 'Deny', action: ['guardrails:*'] },
      ],
    });
    const minted = await turn
      .api()
      .post('/api/v1/api-keys')
      .send({
        name: 'plain',
        project_id: turn.projectId,
        policy_ids: [policy],
      });
    expect(minted.status).toBe(201);

    const res = await authenticatedTestClient(minted.body.key).get(
      `/api/v1/guardrails?project_id=${turn.projectId}`
    );

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  describe('POST /api/v1/policies', () => {
    test('refuses an undeclared code', async () => {
      const res = await turn
        .api()
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [
              {
                ...DENY_GUARDRAILS,
                denial: { ...DENIAL, code: 'NOT_DECLARED' },
              },
            ],
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.meta.details).toEqual([
        'statement[0].denial.code: "NOT_DECLARED" is not a denial code this deployment declares',
      ]);
    });

    test('refuses a denial on an Allow', async () => {
      const res = await turn
        .api()
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [{ ...DENY_GUARDRAILS, effect: 'Allow' }],
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.meta.details).toContain(
        'statement[0].denial: only a Deny statement carries a denial'
      );
    });

    test('refuses a denial meta naming a server key', async () => {
      const res = await turn
        .api()
        .post('/api/v1/policies')
        .send({
          document: {
            statement: [
              {
                ...DENY_GUARDRAILS,
                denial: { ...DENIAL, meta: { action: 'x' } },
              },
            ],
          },
        });

      expect(res.status).toBe(400);
    });

    test('refuses a non-admin writer', async () => {
      const res = await authenticatedTestClient(userToken)
        .post('/api/v1/policies')
        .send({
          project_id: turn.projectId,
          document: { statement: [DENY_GUARDRAILS] },
        });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('POLICY_DENIAL_RESERVED');
    });

    test('refuses a non-admin edit adding a denial', async () => {
      const created = await authenticatedTestClient(userToken)
        .post('/api/v1/policies')
        .send({
          project_id: turn.projectId,
          document: {
            statement: [{ effect: 'Deny', action: ['guardrails:*'] }],
          },
        });
      expect(created.status).toBe(201);

      const res = await authenticatedTestClient(userToken)
        .put(`/api/v1/policies/${created.body.id}`)
        .send({ document: { statement: [DENY_GUARDRAILS] } });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('POLICY_DENIAL_RESERVED');
    });

    test('an admin writes one and reads it back', async () => {
      const res = await turn
        .api()
        .post('/api/v1/policies')
        .send({ document: { statement: [DENY_GUARDRAILS] } });

      expect(res.status).toBe(201);
      expect(res.body.document.statement[0].denial).toEqual(DENIAL);
    });

    test('requires authentication', async () => {
      const res = await authenticatedTestClient('')
        .post('/api/v1/policies')
        .send({ document: { statement: [DENY_GUARDRAILS] } });

      expect(res.status).toBe(401);
    });
  });

  test('a formation by a non-admin refuses a policy carrying a denial', async () => {
    const res = await authenticatedTestClient(userToken)
      .post('/api/v1/formations')
      .send({
        project_id: turn.projectId,
        name: 'denial-stack',
        template: {
          resources: {
            Plan: {
              type: 'policy',
              properties: { document: { statement: [DENY_GUARDRAILS] } },
            },
          },
        },
      });

    expect(res.body.status).not.toBe('active');
    expect(JSON.stringify(res.body)).toContain('POLICY_DENIAL_RESERVED');
  });

  test('an IAM token policy refuses a denial', async () => {
    const res = await authenticatedTestClient(key)
      .post('/api/v1/iam/tokens')
      .send({ policy: { statement: [DENY_GUARDRAILS] } });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IAM_TOKEN_POLICY_INVALID');
  });
});
