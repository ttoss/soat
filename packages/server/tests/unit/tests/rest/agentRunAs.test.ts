import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import { proposeCalls } from '../../fixtures/scriptedModel';
import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * `run_as` states what an agent's `policy_ids` are: a cap on the caller
 * (`caller`), or the agent's own grant (`agent`). What the caller names in
 * the call is checked as the caller in both.
 */
describe('Agent run_as', () => {
  let turn: AgentToolTurn;
  let runnerToken: string;
  let documentId: string;
  let readDocumentsPolicy: string;
  let getDocumentTool: { id: string; name: string };

  const generateAs = (args: {
    token: string;
    agentId: string;
    body: Record<string, unknown>;
  }) => {
    return authenticatedTestClient(args.token)
      .post(`/api/v1/agents/${args.agentId}/generate?wait=true`)
      .send(args.body);
  };

  const readDocumentAs = async (args: { token: string; agentId: string }) => {
    const res = await generateAs({
      ...args,
      body: {
        messages: [
          proposeCalls([
            {
              name: `${getDocumentTool.name}_get-document`,
              args: { document_id: documentId },
            },
          ]),
        ],
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    const results = JSON.parse(res.body.output?.content ?? '[]');
    const generation = await turn
      .api()
      .get(`/api/v1/generations/${res.body.id}`);
    expect(generation.status).toBe(200);
    return { generation: generation.body, result: results[0] };
  };

  beforeAll(async () => {
    turn = await startAgentToolTurn({ prefix: 'runas' });

    const doc = await turn.api().post('/api/v1/documents').send({
      project_id: turn.projectId,
      content: 'the agent reads this',
      path: '/runas/secret.txt',
    });
    expect(doc.status).toBe(201);
    documentId = doc.body.id;

    getDocumentTool = await turn.createTool({
      type: 'builtin',
      execute: undefined,
      parameters: undefined,
      actions: ['get-document'],
    });
    readDocumentsPolicy = await turn.createPolicy({
      statement: [{ effect: 'Allow', action: ['documents:GetDocument'] }],
    });

    const runner = await turn
      .api()
      .post('/api/v1/users')
      .send({ username: 'runasrunner', password: 'runasrunnerpass' });
    expect(runner.status).toBe(201);
    const runOnly = await turn.createPolicy({
      statement: [
        { effect: 'Allow', action: ['agents:CreateAgentGeneration'] },
      ],
    });
    const attach = await turn
      .api()
      .put(`/api/v1/users/${runner.body.id}/policies`)
      .send({ policy_ids: [runOnly] });
    expect(attach.status).toBe(204);
    runnerToken = await loginAs('runasrunner', 'runasrunnerpass');
  });

  afterAll(async () => {
    await turn.close();
  });

  describe('run_as: agent', () => {
    let agentId: string;

    beforeAll(async () => {
      agentId = await turn.createAgent({
        run_as: 'agent',
        policy_ids: [readDocumentsPolicy],
        tool_bindings: [{ tool_id: getDocumentTool.id }],
      });
    });

    test('the agent reports run_as', async () => {
      const res = await turn.api().get(`/api/v1/agents/${agentId}`);

      expect(res.status).toBe(200);
      expect(res.body.run_as).toBe('agent');
    });

    test('a builtin tool reads what the agent holds and the caller does not', async () => {
      const { generation, result } = await readDocumentAs({
        token: runnerToken,
        agentId,
      });

      expect(result.error).toBeUndefined();
      expect(result.id).toBe(documentId);
      expect(generation.acted_as).toEqual({
        principal_type: 'agent',
        principal_id: agentId,
      });
    });

    test('a document the caller names is checked as the caller', async () => {
      const res = await generateAs({
        token: runnerToken,
        agentId,
        body: {
          messages: [
            {
              role: 'user',
              content: { type: 'document', document_id: documentId },
            },
          ],
        },
      });

      expect(res.status).toBe(403);
    });

    test('the agent grant does not reach past its policies', async () => {
      const listFiles = await turn.createTool({
        type: 'builtin',
        execute: undefined,
        parameters: undefined,
        actions: ['list-files'],
      });
      const narrowAgent = await turn.createAgent({
        run_as: 'agent',
        policy_ids: [readDocumentsPolicy],
        tool_bindings: [{ tool_id: listFiles.id }],
      });

      const res = await generateAs({
        token: turn.adminToken,
        agentId: narrowAgent,
        body: {
          messages: [
            proposeCalls([{ name: `${listFiles.name}_list-files`, args: {} }]),
          ],
        },
      });

      const results = JSON.parse(res.body.output?.content ?? '[]');
      expect(results[0].error).toMatchObject({
        code: 'FORBIDDEN',
        meta: { denied_by: { type: 'agent', id: narrowAgent } },
      });
    });
  });

  describe('run_as: caller', () => {
    test('is the default and caps the caller', async () => {
      const agentId = await turn.createAgent({
        policy_ids: [readDocumentsPolicy],
        tool_bindings: [{ tool_id: getDocumentTool.id }],
      });
      const read = await turn.api().get(`/api/v1/agents/${agentId}`);
      expect(read.body.run_as).toBe('caller');

      const { generation, result } = await readDocumentAs({
        token: runnerToken,
        agentId,
      });

      expect(result.error).toMatchObject({ code: 'FORBIDDEN' });
      expect(generation.acted_as?.principal_type).toBe('user');
    });
  });

  describe('writes', () => {
    test('run_as: agent without policy_ids is refused', async () => {
      const agentId = await turn.createAgent({});
      const res = await turn
        .api()
        .post('/api/v1/agents')
        .send({
          project_id: turn.projectId,
          ai_provider_id: (await turn.api().get(`/api/v1/agents/${agentId}`))
            .body.ai_provider_id,
          name: turn.unique('agent'),
          run_as: 'agent',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('AGENT_RUN_AS_REQUIRES_POLICIES');
    });

    test('run_as: agent with an empty policy_ids is refused', async () => {
      const agentId = await turn.createAgent({});

      const res = await turn
        .api()
        .patch(`/api/v1/agents/${agentId}`)
        .send({ run_as: 'agent', policy_ids: [] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('AGENT_RUN_AS_REQUIRES_POLICIES');
    });

    test('detaching every policy from a run_as: agent agent is refused', async () => {
      const agentId = await turn.createAgent({
        run_as: 'agent',
        policy_ids: [readDocumentsPolicy],
      });

      const res = await turn
        .api()
        .patch(`/api/v1/agents/${agentId}`)
        .send({ policy_ids: null });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('AGENT_RUN_AS_REQUIRES_POLICIES');
    });

    test('restoring a version back to run_as: agent keeps the policies it needs', async () => {
      const agentId = await turn.createAgent({
        run_as: 'agent',
        policy_ids: [readDocumentsPolicy],
      });
      const patched = await turn
        .api()
        .patch(`/api/v1/agents/${agentId}`)
        .send({ run_as: 'caller', policy_ids: null });
      expect(patched.status).toBe(200);

      const restored = await turn
        .api()
        .post(`/api/v1/agents/${agentId}/versions/1/restore`)
        .send({});

      expect(restored.status).toBe(200);
      expect(restored.body.run_as).toBe('agent');
      expect(restored.body.policy_ids).toEqual([readDocumentsPolicy]);
    });

    test('an unknown run_as is a validation error', async () => {
      const agentId = await turn.createAgent({});

      const res = await turn
        .api()
        .patch(`/api/v1/agents/${agentId}`)
        .send({ run_as: 'owner' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    test('unauthenticated request returns 401', async () => {
      const res = await testClient
        .post('/api/v1/agents')
        .send({ project_id: turn.projectId, run_as: 'agent' });

      expect(res.status).toBe(401);
    });
  });
});
