import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { db } from 'src/db';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

// End-to-end coverage of the client-tool guardrail gate at the requires_action
// handoff, driven through the real generation entry point. A local HTTP server
// stands in for the AI provider (the sanctioned no-mock pattern), so real
// `ai.generateText` runs over HTTP against responses we control — including a
// tool-call turn that names a client tool.

type StubResponse =
  | { kind: 'client_call'; toolName: string; args: object }
  | { kind: 'text'; content: string };

describe('Client-tool guardrail gate (full generation)', () => {
  let stubServer: Server;
  let stubBaseUrl: string;
  // Queue of responses the stub returns in order, one per model call.
  let stubQueue: StubResponse[] = [];

  let adminToken: string;
  let userToken: string;
  let projectPublicId: string;
  let agentId: string;
  let clientToolId: string;

  const chatCompletion = (response: StubResponse): object => {
    if (response.kind === 'text') {
      return {
        id: 'chatcmpl-stub',
        object: 'chat.completion',
        created: 0,
        model: 'stub-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: response.content },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    }
    return {
      id: 'chatcmpl-stub',
      object: 'chat.completion',
      created: 0,
      model: 'stub-model',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_stub_1',
                type: 'function',
                function: {
                  name: response.toolName,
                  arguments: JSON.stringify(response.args),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  };

  const startStubServer = async (): Promise<string> => {
    stubServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      req.on('data', () => {});
      req.on('end', () => {
        const next = stubQueue.shift() ?? { kind: 'text', content: 'done' };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(chatCompletion(next)));
      });
    });
    await new Promise<void>((resolve) => {
      stubServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = stubServer.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  beforeAll(async () => {
    stubBaseUrl = await startStubServer();

    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'clientgateadmin', password: 'supersecret' });
    adminToken = await loginAs('clientgateadmin', 'supersecret');

    const userRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/users')
      .send({ username: 'clientgateuser', password: 'clientgatepass' });
    userToken = await loginAs('clientgateuser', 'clientgatepass');

    const policyRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/policies')
      .send({
        document: {
          statement: [
            {
              effect: 'Allow',
              action: ['agents:CreateAgent', 'agents:CreateAgentGeneration'],
            },
          ],
        },
      });
    await authenticatedTestClient(adminToken)
      .put(`/api/v1/users/${userRes.body.id}/policies`)
      .send({ policy_ids: [policyRes.body.id] });

    const projectRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/projects')
      .send({ name: 'Client Gate Gen Project' });
    projectPublicId = projectRes.body.id;

    const aiProvRes = await authenticatedTestClient(adminToken)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectPublicId,
        name: 'Stub Provider',
        provider: 'ollama',
        default_model: 'stub-model',
        base_url: stubBaseUrl,
      });

    // A client tool the model will call; it has no server execute.
    const clientTool = await db.Tool.create({
      projectId: (await db.Project.findOne({
        where: { publicId: projectPublicId },
      }))!.id,
      type: 'client',
      name: 'read_local_file',
      description: 'Read a file on the caller machine',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
      },
    });
    clientToolId = clientTool.publicId;

    const agentRes = await authenticatedTestClient(userToken)
      .post('/api/v1/agents')
      .send({
        ai_provider_id: aiProvRes.body.id,
        project_id: projectPublicId,
        name: 'Client Gate Agent',
        tool_ids: [clientToolId],
      });
    agentId = agentRes.body.id;
  });

  afterEach(async () => {
    stubQueue = [];
    await db.Tool.update(
      { guardrailIds: null },
      { where: { publicId: clientToolId } }
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      stubServer.close((err) => {
        return err ? reject(err) : resolve();
      });
    });
  });

  const attachGuardrail = async (document: object): Promise<void> => {
    const res = await authenticatedTestClient(adminToken)
      .post('/api/v1/guardrails')
      .send({ name: `gen-client-guard-${Math.random()}`, document });
    await db.Tool.update(
      { guardrailIds: [res.body.id] },
      { where: { publicId: clientToolId } }
    );
  };

  test('with no guardrail, a client tool call suspends at requires_action', async () => {
    stubQueue = [
      {
        kind: 'client_call',
        toolName: 'read_local_file',
        args: { path: '/a' },
      },
    ];
    const res = await authenticatedTestClient(userToken)
      .post(`/api/v1/agents/${agentId}/generate`)
      .send({ messages: [{ role: 'user', content: 'read it' }] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('requires_action');
    expect(res.body.required_action.tool_calls[0].tool_name).toBe(
      'read_local_file'
    );
  });

  test('class D blocks the handoff — the model resumes and completes, never suspends', async () => {
    await attachGuardrail({ class: 'D' });
    stubQueue = [
      {
        kind: 'client_call',
        toolName: 'read_local_file',
        args: { path: '/a' },
      },
      { kind: 'text', content: 'I could not read the file.' },
    ];
    const res = await authenticatedTestClient(userToken)
      .post(`/api/v1/agents/${agentId}/generate`)
      .send({ messages: [{ role: 'user', content: 'read it' }] });

    // All (one) client calls were gated → synthesized result → resume → complete.
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.output.content).toBe('I could not read the file.');
  });

  test('class C files an approval, the model resumes, and completes', async () => {
    await attachGuardrail({ class: 'C' });
    stubQueue = [
      {
        kind: 'client_call',
        toolName: 'read_local_file',
        args: { path: '/a' },
      },
      { kind: 'text', content: 'I have requested approval.' },
    ];
    const before = await db.ApprovalItem.count({
      where: { origin: 'tool_call', status: 'pending' },
    });
    const res = await authenticatedTestClient(userToken)
      .post(`/api/v1/agents/${agentId}/generate`)
      .send({ messages: [{ role: 'user', content: 'read it' }] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    const after = await db.ApprovalItem.count({
      where: { origin: 'tool_call', status: 'pending' },
    });
    expect(after).toBe(before + 1);
  });

  test('class A releases the call to the client (suspends at requires_action)', async () => {
    await attachGuardrail({ class: 'A' });
    stubQueue = [
      {
        kind: 'client_call',
        toolName: 'read_local_file',
        args: { path: '/a' },
      },
    ];
    const res = await authenticatedTestClient(userToken)
      .post(`/api/v1/agents/${agentId}/generate`)
      .send({ messages: [{ role: 'user', content: 'read it' }] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('requires_action');
    expect(res.body.required_action.tool_calls[0].tool_name).toBe(
      'read_local_file'
    );
  });
});
