import crypto from 'node:crypto';

import { drainQueueOnce } from 'src/lib/orchestrationWorker';

import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { pollFor } from '../../fixtures/poll';
import { proposeCalls } from '../../fixtures/scriptedModel';
import { authenticatedTestClient } from '../../testClient';

/**
 * A tool server reads whom the whole chain of work acts for from the signed
 * `acts_for` claim, however the call was reached: agent → `builtin` tool →
 * orchestration run → `pipeline` tool → agent → `mcp` tool, in the request
 * or resumed by a worker from the run's stored authority.
 */

const ACTIONS = ['agents:*', 'tools:*', 'orchestrations:*'];
const PRINCIPAL = { type: 'grant', id: 'grant_chain' };

const claimsOf = (token: string): Record<string, unknown> => {
  return JSON.parse(
    Buffer.from(token.split('.')[1], 'base64url').toString('utf-8')
  );
};

describe('the acts_for claim of a tool assertion', () => {
  let turn: AgentToolTurn;
  let projectKey: string;
  let starterAgentId: string;
  let startTool: { id: string; name: string };
  let mcpPath: string;
  let mcpToolId: string;
  const saved = {
    key: process.env.TOOL_ASSERTION_PRIVATE_KEY,
    worker: process.env.ORCHESTRATION_WORKER_DISABLED,
  };

  /** The claims of every `tools/call` the end of the chain received. */
  const callClaims = () => {
    return turn.target
      .requestsAt(mcpPath)
      .filter((request) => {
        return request.body.method === 'tools/call';
      })
      .map((request) => {
        return claimsOf(request.headers['x-soat-tool-assertion'] as string);
      });
  };

  const awaitCallClaims = () => {
    return pollFor({
      read: callClaims,
      pick: (claims) => {
        return claims.length > 0 ? claims : undefined;
      },
    });
  };

  const tokenFor = async (principal?: { type: string; id: string }) => {
    const res = await authenticatedTestClient(projectKey)
      .post('/api/v1/iam/tokens')
      .send({
        policy: { statement: [{ effect: 'Allow', action: ACTIONS }] },
        ...(principal ? { principal } : {}),
      });
    expect(res.status).toBe(201);
    return res.body.token as string;
  };

  /** Agent A's turn: its `builtin` tool starts the orchestration run. */
  const startChain = async (args: { credential: string; wait: boolean }) => {
    const res = await authenticatedTestClient(args.credential)
      .post(`/api/v1/agents/${starterAgentId}/generate?wait=true`)
      .send({
        messages: [
          proposeCalls([
            {
              name: `${startTool.name}_start-orchestration-run`,
              args: {
                input: {
                  message: JSON.stringify({
                    calls: [{ name: 'echo', args: {} }],
                  }),
                },
                ...(args.wait ? { wait: true } : {}),
              },
            },
          ]),
        ],
        tool_context: { acts_for: 'forged' },
      });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
  };

  beforeAll(async () => {
    process.env.ORCHESTRATION_WORKER_DISABLED = 'true';
    process.env.TOOL_ASSERTION_PRIVATE_KEY = crypto
      .generateKeyPairSync('ed25519')
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    turn = await startAgentToolTurn({ prefix: 'assertactsfor' });

    const policyId = await turn.createPolicy({
      statement: [
        {
          effect: 'Allow',
          action: [...ACTIONS, 'iam:CreateToken', 'iam:RevokePrincipal'],
        },
      ],
    });
    const key = await turn
      .api()
      .post('/api/v1/api-keys')
      .send({
        name: turn.unique('key'),
        project_id: turn.projectId,
        policy_ids: [policyId],
      });
    expect(key.status).toBe(201);
    projectKey = key.body.key;

    mcpPath = `/${turn.unique('mcp')}`;
    turn.target.reply(mcpPath, (body) => {
      const result =
        body.method === 'tools/list'
          ? { tools: [{ name: 'echo' }] }
          : { content: [{ type: 'text', text: '{"ok":true}' }] };
      return { body: { jsonrpc: '2.0', id: body.id, result } };
    });
    mcpToolId = (
      await turn.createTool({
        type: 'mcp',
        execute: undefined,
        parameters: undefined,
        mcp: { url: `${turn.target.baseUrl}${mcpPath}` },
      })
    ).id;
    const endAgentId = await turn.createAgent({
      tool_bindings: [{ tool_id: mcpToolId }],
    });

    const generateTool = await turn.createTool({
      type: 'builtin',
      execute: undefined,
      parameters: undefined,
      actions: ['create-agent-generation'],
    });
    const askTool = await turn.createTool({
      type: 'pipeline',
      execute: undefined,
      parameters: {
        type: 'object',
        properties: { message: { type: 'string' } },
      },
      pipeline: {
        steps: [
          {
            id: 'ask',
            tool_id: generateTool.id,
            action: 'create-agent-generation',
            input: {
              agent_id: endAgentId,
              messages: [{ role: 'user', content: { var: 'input.message' } }],
            },
          },
        ],
      },
    });
    const orchestration = await turn
      .api()
      .post('/api/v1/orchestrations')
      .send({
        project_id: turn.projectId,
        name: turn.unique('chain'),
        nodes: [
          {
            id: 'ask',
            type: 'tool',
            tool_id: askTool.id,
            input_mapping: { message: { var: 'input.message' } },
          },
        ],
        edges: [],
      });
    expect(orchestration.status).toBe(201);

    startTool = await turn.createTool({
      type: 'builtin',
      execute: undefined,
      parameters: undefined,
      actions: ['start-orchestration-run'],
      preset_parameters: { orchestration_id: orchestration.body.id },
    });
    starterAgentId = await turn.createAgent({
      tool_bindings: [{ tool_id: startTool.id }],
    });
  });

  beforeEach(() => {
    turn.target.reset();
  });

  afterAll(async () => {
    for (const [name, value] of [
      ['TOOL_ASSERTION_PRIVATE_KEY', saved.key],
      ['ORCHESTRATION_WORKER_DISABLED', saved.worker],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await turn.close();
  });

  test('reaches the end of a waited chain', async () => {
    await startChain({ credential: await tokenFor(PRINCIPAL), wait: true });

    const [claims] = await awaitCallClaims();
    expect(claims.acts_for).toEqual(PRINCIPAL);
  });

  test('reaches the end of a run a worker resumes from its stored authority', async () => {
    await startChain({ credential: await tokenFor(PRINCIPAL), wait: false });
    expect(callClaims()).toEqual([]);

    expect(await drainQueueOnce()).toBe(1);

    const [claims] = await awaitCallClaims();
    expect(claims.acts_for).toEqual(PRINCIPAL);
  });

  test('is absent for a credential acting for no principal, whatever the caller sends', async () => {
    await startChain({ credential: await tokenFor(), wait: true });

    const [claims] = await awaitCallClaims();
    expect(claims).not.toHaveProperty('acts_for');
  });

  test('a direct call on the token carries it', async () => {
    const res = await authenticatedTestClient(await tokenFor(PRINCIPAL))
      .post(`/api/v1/tools/${mcpToolId}/call`)
      .send({ action: 'echo', input: {} });
    expect(res.status).toBe(200);

    const [claims] = callClaims();
    expect(claims.acts_for).toEqual(PRINCIPAL);
  });

  test('a run whose principal is revoked fails before the end is called', async () => {
    const revoked = { type: 'grant', id: 'grant_revoked' };
    await startChain({ credential: await tokenFor(revoked), wait: false });
    const revoke = await authenticatedTestClient(projectKey)
      .post('/api/v1/iam/principal-revocations')
      .send({ principal: revoked });
    expect(revoke.status).toBe(204);

    expect(await drainQueueOnce()).toBe(1);

    const runs = await turn
      .api()
      .get(`/api/v1/orchestration-runs?project_id=${turn.projectId}`);
    expect(runs.status).toBe(200);
    const [run] = runs.body.data as Array<{
      status: string;
      error: { code: string } | null;
    }>;
    expect(run.status).toBe('failed');
    expect(run.error?.code).toBe('WORK_AUTHORITY_MISSING');
    expect(callClaims()).toEqual([]);
  });
});
