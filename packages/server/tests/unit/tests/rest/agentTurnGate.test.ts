import { agentRefusal } from '../../fixtures/agentRefusal';
import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { proposeCalls } from '../../fixtures/scriptedModel';
import { authenticatedTestClient, loginAs } from '../../testClient';

/**
 * Every tool an agent calls, and every read of what it injects, crosses one
 * gate under the turn's authority: the caller held to the agent's
 * `policy_ids` (`run_as: caller`), or the agent's grant (`run_as: agent`).
 * What the caller names in the call is checked as the caller.
 */
describe('the agent turn gate', () => {
  let turn: AgentToolTurn;
  let seq = 0;

  const RUN_AGENTS = {
    effect: 'Allow',
    action: ['agents:CreateAgentGeneration'],
  };

  /** A user holding `statements`, and the token it signs in with. */
  const userWith = async (statements: object[]): Promise<string> => {
    seq += 1;
    const username = `gateuser${seq}`;
    const user = await turn
      .api()
      .post('/api/v1/users')
      .send({ username, password: `${username}pass` });
    expect(user.status).toBe(201);
    const policy = await turn.createPolicy({ statement: statements });
    const attach = await turn
      .api()
      .put(`/api/v1/users/${user.body.id}/policies`)
      .send({ policy_ids: [policy] });
    expect(attach.status).toBe(204);
    return loginAs(username, `${username}pass`);
  };

  const generateAs = async (args: {
    token: string;
    agentId: string;
    messages: object[];
  }) => {
    const res = await authenticatedTestClient(args.token)
      .post(`/api/v1/agents/${args.agentId}/generate?wait=true`)
      .send({ messages: args.messages });
    return res;
  };

  const callAs = async (args: {
    token: string;
    agentId: string;
    name: string;
    toolArgs?: Record<string, unknown>;
  }) => {
    const res = await generateAs({
      token: args.token,
      agentId: args.agentId,
      messages: [
        proposeCalls([{ name: args.name, args: args.toolArgs ?? {} }]),
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    return JSON.parse(res.body.output?.content ?? '[]')[0];
  };

  const toolSrn = (toolId: string) => {
    return `srn:${turn.projectId}:tool:${toolId}`;
  };

  beforeAll(async () => {
    turn = await startAgentToolTurn({ prefix: 'turngate' });
  });

  afterAll(async () => {
    await turn.close();
  });

  describe('an http tool under run_as: caller', () => {
    test('is refused a caller without tools:CallTool on it', async () => {
      const tool = await turn.createTool();
      const agentId = await turn.createAgent({
        tool_bindings: [{ tool_id: tool.id }],
      });
      const token = await userWith([RUN_AGENTS]);

      const result = await callAs({ token, agentId, name: tool.name });

      expect(result.error).toMatchObject({
        code: 'FORBIDDEN',
        meta: { action: 'tools:CallTool', resource: toolSrn(tool.id) },
      });
      expect(turn.target.requestsAt(`/${tool.name}`)).toHaveLength(0);
    });

    test('runs for a caller holding tools:CallTool on it', async () => {
      const tool = await turn.createTool();
      const agentId = await turn.createAgent({
        tool_bindings: [{ tool_id: tool.id }],
      });
      const token = await userWith([
        RUN_AGENTS,
        {
          effect: 'Allow',
          action: ['tools:CallTool'],
          resource: [toolSrn(tool.id)],
        },
      ]);

      const result = await callAs({ token, agentId, name: tool.name });

      expect(result).toEqual({ ok: true });
      expect(turn.target.requestsAt(`/${tool.name}`)).toHaveLength(1);
    });

    test("is refused when the agent's policy_ids deny it", async () => {
      const tool = await turn.createTool();
      const agentId = await turn.createAgent({
        tool_bindings: [{ tool_id: tool.id }],
        policy_ids: [
          await turn.createPolicy({
            statement: [{ effect: 'Deny', action: ['tools:CallTool'] }],
          }),
        ],
      });

      const result = await callAs({
        token: turn.adminToken,
        agentId,
        name: tool.name,
      });

      expect(result).toEqual(
        agentRefusal({ agentId, action: 'tools:CallTool' })
      );
    });
  });

  describe('an http tool under run_as: agent', () => {
    test('is refused when the agent grant lacks tools:CallTool', async () => {
      const tool = await turn.createTool();
      const agentId = await turn.createAgent({
        run_as: 'agent',
        tool_bindings: [{ tool_id: tool.id }],
        policy_ids: [
          await turn.createPolicy({
            statement: [{ effect: 'Allow', action: ['documents:GetDocument'] }],
          }),
        ],
      });

      const result = await callAs({
        token: turn.adminToken,
        agentId,
        name: tool.name,
      });

      expect(result).toEqual(
        agentRefusal({ agentId, action: 'tools:CallTool' })
      );
    });

    test('runs on the agent grant for a caller who holds none', async () => {
      const tool = await turn.createTool();
      const agentId = await turn.createAgent({
        run_as: 'agent',
        tool_bindings: [{ tool_id: tool.id }],
        policy_ids: [
          await turn.createPolicy({
            statement: [{ effect: 'Allow', action: ['tools:CallTool'] }],
          }),
        ],
      });
      const token = await userWith([RUN_AGENTS]);

      const result = await callAs({ token, agentId, name: tool.name });

      expect(result).toEqual({ ok: true });
    });
  });

  describe('a pipeline', () => {
    test('is refused a step the caller may not call', async () => {
      const step = await turn.createTool();
      const pipeline = await turn.createTool({
        type: 'pipeline',
        execute: undefined,
        parameters: { type: 'object', properties: {} },
        pipeline: {
          steps: [{ id: 'one', tool_id: step.id, input: { amount: 1 } }],
        },
      });
      const agentId = await turn.createAgent({
        tool_bindings: [{ tool_id: pipeline.id }],
      });
      const token = await userWith([
        RUN_AGENTS,
        {
          effect: 'Allow',
          action: ['tools:CallTool'],
          resource: [toolSrn(pipeline.id)],
        },
      ]);

      const result = await callAs({ token, agentId, name: pipeline.name });

      // A thrown tool error reaches the model as `{ "error": <message> }`.
      expect(result.error).toContain(
        `Pipeline step 'one' failed: Forbidden: user`
      );
      expect(result.error).toContain(
        `deny tools:CallTool on ${toolSrn(step.id)}`
      );
      expect(turn.target.requestsAt(`/${step.name}`)).toHaveLength(0);
    });
  });

  describe('write_memory', () => {
    const storeAgent = async (body: Record<string, unknown>) => {
      const store = await turn
        .api()
        .post('/api/v1/memory-stores')
        .send({ project_id: turn.projectId, name: turn.unique('store') });
      expect(store.status).toBe(201);
      return turn.createAgent({
        knowledge_config: { write_memory_store_id: store.body.id },
        ...body,
      });
    };

    test('under run_as: caller is refused a caller who may not write memories', async () => {
      const agentId = await storeAgent({});
      const token = await userWith([RUN_AGENTS]);

      const result = await callAs({
        token,
        agentId,
        name: 'write_memory',
        toolArgs: { content: 'The office is in Lisbon.' },
      });

      expect(result.error).toMatchObject({
        code: 'FORBIDDEN',
        meta: { action: 'memories:CreateMemory' },
      });
    });

    test('under run_as: agent writes on the agent grant', async () => {
      const agentId = await storeAgent({
        run_as: 'agent',
        policy_ids: [
          await turn.createPolicy({
            statement: [
              {
                effect: 'Allow',
                action: ['memories:CreateMemory', 'memories:UpdateMemory'],
              },
            ],
          }),
        ],
      });
      const token = await userWith([RUN_AGENTS]);

      const result = await callAs({
        token,
        agentId,
        name: 'write_memory',
        toolArgs: { content: 'The office is in Porto.' },
      });

      expect(result.error).toBeUndefined();
      expect(result.memoryId).toBeDefined();
    });
  });

  describe("the agent's stored knowledge", () => {
    const SECRET = 'The gate test vault code is 9191.';

    const knowledgeAgent = async (body: Record<string, unknown>) => {
      const path = `/turngate/${turn.unique('kb')}/vault.txt`;
      const doc = await turn
        .api()
        .post('/api/v1/documents')
        .send({ project_id: turn.projectId, content: SECRET, path });
      expect(doc.status).toBe(201);
      return turn.createAgent({
        knowledge_config: { document_paths: [path] },
        ...body,
      });
    };

    const injected = (requestsBefore: number): boolean => {
      return turn.model.requests.slice(requestsBefore).some((request) => {
        return JSON.stringify(request.messages).includes('9191');
      });
    };

    test('reaches a caller who may search it', async () => {
      const agentId = await knowledgeAgent({});
      const before = turn.model.requests.length;

      await callAs({ token: turn.adminToken, agentId, name: 'none' });

      expect(injected(before)).toBe(true);
    });

    test('under run_as: caller is not read for a caller who may not search it', async () => {
      const agentId = await knowledgeAgent({});
      const token = await userWith([RUN_AGENTS]);
      const before = turn.model.requests.length;

      await callAs({ token, agentId, name: 'none' });

      expect(injected(before)).toBe(false);
    });
  });

  describe('a tool_output the caller names', () => {
    test("is checked as the caller, on the action the tool's input names", async () => {
      const doc = await turn
        .api()
        .post('/api/v1/documents')
        .send({
          project_id: turn.projectId,
          content: 'named by the caller',
          path: `/turngate/${turn.unique('named')}.txt`,
        });
      expect(doc.status).toBe(201);
      const getDocument = await turn.createTool({
        type: 'builtin',
        execute: undefined,
        parameters: undefined,
        actions: ['get-document'],
      });
      const agentId = await turn.createAgent({
        tool_bindings: [{ tool_id: getDocument.id }],
      });
      const token = await userWith([
        RUN_AGENTS,
        { effect: 'Allow', action: ['tools:CallTool', 'tools:GetTool'] },
      ]);

      const res = await generateAs({
        token,
        agentId,
        messages: [
          {
            role: 'user',
            content: {
              type: 'tool_output',
              tool_id: getDocument.id,
              input: { action: 'get-document', document_id: doc.body.id },
            },
          },
        ],
      });

      expect(res.status).toBe(403);
      expect(res.body.error.meta.action).toBe('documents:GetDocument');
    });
  });

  describe('a tool_output under run_as: caller', () => {
    test("is held to the agent's policy_ids on the action its input names", async () => {
      const doc = await turn
        .api()
        .post('/api/v1/documents')
        .send({
          project_id: turn.projectId,
          content: 'capped by the agent',
          path: `/turngate/${turn.unique('capped')}.txt`,
        });
      expect(doc.status).toBe(201);
      const getDocument = await turn.createTool({
        type: 'builtin',
        execute: undefined,
        parameters: undefined,
        actions: ['get-document'],
      });
      const agentId = await turn.createAgent({
        tool_bindings: [{ tool_id: getDocument.id }],
        policy_ids: [
          await turn.createPolicy({
            statement: [
              { effect: 'Allow', action: ['tools:*'] },
              { effect: 'Deny', action: ['documents:GetDocument'] },
            ],
          }),
        ],
      });

      const res = await generateAs({
        token: turn.adminToken,
        agentId,
        messages: [
          {
            role: 'user',
            content: {
              type: 'tool_output',
              tool_id: getDocument.id,
              input: { action: 'get-document', document_id: doc.body.id },
            },
          },
        ],
      });

      expect(res.status).toBe(403);
      expect(res.body.error.meta).toMatchObject({
        action: 'documents:GetDocument',
        denied_by: { type: 'agent', id: agentId },
      });
    });
  });

  describe('a conversation turn', () => {
    test('naming an agent the caller may not run is refused', async () => {
      const agentId = await turn.createAgent({});
      const conversation = await turn
        .api()
        .post('/api/v1/conversations')
        .send({ project_id: turn.projectId });
      expect(conversation.status).toBe(201);
      const token = await userWith([
        {
          effect: 'Allow',
          action: ['conversations:GenerateConversationMessage'],
        },
      ]);

      const res = await authenticatedTestClient(token)
        .post(`/api/v1/conversations/${conversation.body.id}/generate`)
        .send({ agent_id: agentId });

      expect(res.status).toBe(403);
      expect(res.body.error.meta).toMatchObject({
        action: 'agents:CreateAgentGeneration',
        resource: `srn:${turn.projectId}:agent:${agentId}`,
      });
    });
  });

  describe('a direct tool call', () => {
    test('naming an actor the caller may not read is refused', async () => {
      const tool = await turn.createTool();
      const actor = await turn
        .api()
        .post('/api/v1/actors')
        .send({ project_id: turn.projectId, name: turn.unique('actor') });
      expect(actor.status).toBe(201);
      const token = await userWith([
        { effect: 'Allow', action: ['tools:CallTool'] },
      ]);

      const res = await authenticatedTestClient(token)
        .post(`/api/v1/tools/${tool.id}/call`)
        .send({ input: { amount: 1 }, actor_id: actor.body.id });

      expect(res.status).toBe(403);
      expect(res.body.error.meta.action).toBe('actors:GetActor');
      expect(turn.target.requestsAt(`/${tool.name}`)).toHaveLength(0);
    });
  });
});
