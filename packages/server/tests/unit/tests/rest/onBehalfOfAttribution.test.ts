import crypto from 'node:crypto';

import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { proposeCalls } from '../../fixtures/scriptedModel';
import { authenticatedTestClient } from '../../testClient';

/**
 * A callback presenting a generation's assertion is refused in the name of
 * the cap that refused it: a project's `agent_policy_ids` or the agent's
 * `policy_ids`, each attributed as on the turn itself. What narrows the
 * original caller's own credential stays the assertion's.
 */

const HEADER = 'X-Soat-On-Behalf-Of';
const ALLOW_ALL = { effect: 'Allow', action: ['*'] };
const DENY_READ = { effect: 'Deny', action: ['documents:GetDocument'] };

describe('On-Behalf-Of denial attribution', () => {
  let turn: AgentToolTurn;
  let projectKey: string;
  let toolId: string;
  let mcpPath: string;
  let documentId: string;
  const savedKey = process.env.TOOL_ASSERTION_PRIVATE_KEY;

  const lastAssertion = (): string => {
    const calls = turn.target.requestsAt(mcpPath).filter((request) => {
      return request.body.method === 'tools/call';
    });
    return calls[calls.length - 1].headers['x-soat-tool-assertion'] as string;
  };

  const callbackOf = async (body: Record<string, unknown>) => {
    const agentId = await turn.createAgent({
      tool_bindings: [{ tool_id: toolId }],
      ...body,
    });
    await turn.generate({ agentId, calls: [{ name: 'echo', args: {} }] });
    return { agentId, assertion: lastAssertion() };
  };

  const readDocument = (assertion: string) => {
    return authenticatedTestClient(projectKey)
      .get(`/api/v1/documents/${documentId}`)
      .set(HEADER, assertion);
  };

  const setProjectCap = async (statement: object[] | null) => {
    const res = await turn
      .api()
      .patch(`/api/v1/projects/${turn.projectId}`)
      .send({
        agent_policy_ids: statement
          ? [await turn.createPolicy({ statement })]
          : null,
      });
    expect(res.status).toBe(200);
  };

  beforeAll(async () => {
    const pair = crypto.generateKeyPairSync('ed25519');
    process.env.TOOL_ASSERTION_PRIVATE_KEY = pair.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
    turn = await startAgentToolTurn({ prefix: 'oboattribution' });

    mcpPath = `/${turn.unique('mcp')}`;
    turn.target.reply(mcpPath, (body) => {
      const result =
        body.method === 'tools/list'
          ? { tools: [{ name: 'echo' }] }
          : { content: [{ type: 'text', text: '{"ok":true}' }] };
      return { body: { jsonrpc: '2.0', id: body.id, result } };
    });
    const tool = await turn.createTool({
      type: 'mcp',
      execute: undefined,
      parameters: undefined,
      mcp: { url: `${turn.target.baseUrl}${mcpPath}` },
    });
    toolId = tool.id;

    const key = await turn
      .api()
      .post('/api/v1/api-keys')
      .send({ name: 'tool server key', project_id: turn.projectId });
    expect(key.status).toBe(201);
    projectKey = key.body.key;

    const doc = await turn
      .api()
      .post('/api/v1/documents')
      .send({ project_id: turn.projectId, content: 'private guide' });
    expect(doc.status).toBe(201);
    documentId = doc.body.id;
  });

  afterAll(async () => {
    if (savedKey === undefined) delete process.env.TOOL_ASSERTION_PRIVATE_KEY;
    else process.env.TOOL_ASSERTION_PRIVATE_KEY = savedKey;
    await turn.close();
  });

  test("a denial by the project's agent_policy_ids names the project", async () => {
    await setProjectCap([ALLOW_ALL, DENY_READ]);
    try {
      const { assertion } = await callbackOf({});

      const res = await readDocument(assertion);

      expect(res.status).toBe(403);
      expect(res.body.error.meta).toMatchObject({
        action: 'documents:GetDocument',
        denied_by: { type: 'project', id: turn.projectId },
      });
    } finally {
      await setProjectCap(null);
    }
  });

  test("a denial by the agent's policy_ids names the agent", async () => {
    const { agentId, assertion } = await callbackOf({
      policy_ids: [
        await turn.createPolicy({ statement: [ALLOW_ALL, DENY_READ] }),
      ],
    });

    const res = await readDocument(assertion);

    expect(res.status).toBe(403);
    expect(res.body.error.meta).toMatchObject({
      denied_by: { type: 'agent', id: agentId },
    });
  });

  test('a denial by the original caller names the assertion, not the caller', async () => {
    const policyId = await turn.createPolicy({
      statement: [
        { effect: 'Allow', action: ['agents:*', 'tools:*', 'documents:*'] },
        DENY_READ,
      ],
    });
    const narrow = await turn
      .api()
      .post('/api/v1/api-keys')
      .send({
        name: turn.unique('narrow'),
        project_id: turn.projectId,
        policy_ids: [policyId],
      });
    expect(narrow.status).toBe(201);
    const agentId = await turn.createAgent({
      tool_bindings: [{ tool_id: toolId }],
    });
    const generation = await authenticatedTestClient(narrow.body.key)
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({ messages: [proposeCalls([{ name: 'echo', args: {} }])] });
    expect(generation.body.status).toBe('completed');

    const res = await readDocument(lastAssertion());

    expect(res.status).toBe(403);
    expect(res.body.error.meta).toMatchObject({
      denied_by: { type: 'on_behalf_of', id: null },
    });
  });
});
