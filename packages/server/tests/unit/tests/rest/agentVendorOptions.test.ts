import type { Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { authenticatedTestClient, loginAs, testClient } from '../../testClient';

/**
 * Vendor options (`providerOptions`) ride the AI SDK messages a turn stores:
 * here an Anthropic reasoning signature. A replay sends them back to the
 * model; no response, trace or stored message a caller reads carries them.
 */
describe('Agent vendor options', () => {
  let stubServer: Server;
  let requestBodies: Array<Record<string, unknown>>;
  let token: string;
  let projectId: string;
  let agentId: string;

  type Block = Record<string, unknown>;
  type WireMessage = { role: string; content: Block[] | string };

  const toolResultCount = (body: Record<string, unknown>): number => {
    return (JSON.stringify(body.messages).match(/"tool_result"/g) ?? []).length;
  };

  /** One tool call, then a text answer; every answer opens with signed thinking. */
  const startStubServer = async (): Promise<string> => {
    stubServer = createServer((req, res: ServerResponse) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = JSON.parse(raw);
        requestBodies.push(body);
        const toolName = (
          body.tools as Array<{ name: string }> | undefined
        )?.[0]?.name;
        const messages = body.messages as WireMessage[];
        const callTool =
          toolName && toolResultCount({ messages: messages.slice(-1) }) === 0;
        const thinking = {
          type: 'thinking',
          thinking: 'considering',
          signature: `sig_${requestBodies.length}`,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'msg_stub',
            type: 'message',
            role: 'assistant',
            model: 'claude-haiku-4-5',
            stop_reason: callTool ? 'tool_use' : 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 4, output_tokens: 2 },
            content: callTool
              ? [
                  thinking,
                  {
                    type: 'tool_use',
                    id: `toolu_stub_${requestBodies.length}`,
                    name: toolName,
                    input: {},
                  },
                ]
              : [thinking, { type: 'text', text: 'done' }],
          })
        );
      });
    });
    await new Promise<void>((resolve) => {
      stubServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = stubServer.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  const signaturesSent = (body: Record<string, unknown>): string[] => {
    return (body.messages as WireMessage[]).flatMap((message) => {
      return Array.isArray(message.content)
        ? message.content.flatMap((block) => {
            return block.type === 'thinking' ? [String(block.signature)] : [];
          })
        : [];
    });
  };

  const expectNoVendorOptions = (body: unknown) => {
    expect(JSON.stringify(body)).not.toContain('providerOptions');
  };

  const downloadText = async (fileId: string): Promise<string> => {
    const download = await authenticatedTestClient(token)
      .get(`/api/v1/files/${fileId}/download`)
      .buffer(true)
      .parse((response, callback) => {
        let text = '';
        response.on('data', (chunk: Buffer) => {
          text += chunk.toString('utf8');
        });
        response.on('end', () => {
          callback(null, text);
        });
      });
    expect(download.status).toBe(200);
    return download.body;
  };

  beforeAll(async () => {
    requestBodies = [];
    const stubBaseUrl = await startStubServer();

    await testClient
      .post('/api/v1/users/bootstrap')
      .send({ username: 'vendoroptsadmin', password: 'supersecret' });
    token = await loginAs('vendoroptsadmin', 'supersecret');

    const projectRes = await authenticatedTestClient(token)
      .post('/api/v1/projects')
      .send({ name: 'Vendor Options Project' });
    projectId = projectRes.body.id;

    const secretRes = await authenticatedTestClient(token)
      .post('/api/v1/secrets')
      .send({ project_id: projectId, name: 'Vendor Options Key', value: 'sk' });

    const aiProviderRes = await authenticatedTestClient(token)
      .post('/api/v1/ai-providers')
      .send({
        project_id: projectId,
        name: 'Stub Anthropic',
        provider: 'anthropic',
        default_model: 'claude-haiku-4-5',
        secret_id: secretRes.body.id,
        base_url: stubBaseUrl,
      });

    const toolRes = await authenticatedTestClient(token)
      .post('/api/v1/tools')
      .send({
        project_id: projectId,
        name: 'lookup_tool',
        type: 'http',
        description: 'Look something up',
        parameters: { type: 'object', properties: {} },
        execute: { url: 'http://127.0.0.1:1/unused', method: 'POST' },
      });

    const agentRes = await authenticatedTestClient(token)
      .post('/api/v1/agents')
      .send({
        ai_provider_id: aiProviderRes.body.id,
        project_id: projectId,
        model: 'claude-haiku-4-5',
        name: 'Vendor Options Agent',
        instructions: 'Be terse.',
        prompt_caching: { enabled: true },
        tool_bindings: [{ tool_id: toolRes.body.id }],
        max_steps: 5,
      });
    expect(agentRes.status).toBe(201);
    agentId = agentRes.body.id;
  });

  beforeEach(() => {
    requestBodies = [];
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      stubServer.close(() => {
        return resolve();
      });
    });
  });

  describe('POST /api/v1/agents/{agent_id}/generate', () => {
    test('response_messages keep reasoning and tool calls without vendor options', async () => {
      const res = await authenticatedTestClient(token)
        .post(`/api/v1/agents/${agentId}/generate?wait=true`)
        .send({ messages: [{ role: 'user', content: 'go' }] });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      const partTypes = (
        res.body.output.response_messages as Array<{
          content: Array<{ type: string }> | string;
        }>
      ).flatMap((message) => {
        return Array.isArray(message.content)
          ? message.content.map((part) => {
              return part.type;
            })
          : [];
      });
      expect(partTypes).toEqual(
        expect.arrayContaining(['reasoning', 'tool-call', 'text'])
      );
      expectNoVendorOptions(res.body);
    });

    test('the trace steps carry no vendor options', async () => {
      const res = await authenticatedTestClient(token)
        .post(`/api/v1/agents/${agentId}/generate?wait=true`)
        .send({ messages: [{ role: 'user', content: 'go' }] });
      expect(res.status).toBe(200);

      const files = await authenticatedTestClient(token).get(
        `/api/v1/files?project_id=${projectId}&path_prefix=/.system/traces/${res.body.trace_id}/${res.body.id}`
      );
      expect(files.body.data).toHaveLength(2);
      const steps = await Promise.all(
        files.body.data.map((file: { id: string }) => {
          return downloadText(file.id);
        })
      );
      expect(steps.join('')).toContain('"reasoning"');
      for (const step of steps) expectNoVendorOptions(step);

      const transcript = await authenticatedTestClient(token).get(
        `/api/v1/generations/${res.body.id}/transcript`
      );
      expect(transcript.status).toBe(200);
      expectNoVendorOptions(transcript.body);
    });
  });

  describe('POST /api/v1/sessions/{session_id}/generate', () => {
    const createSession = async (): Promise<string> => {
      const res = await authenticatedTestClient(token)
        .post('/api/v1/sessions')
        .send({ agent_id: agentId, name: `Vendor ${requestBodies.length}` });
      expect(res.status).toBe(201);
      return res.body.id;
    };

    const turn = async (sessionId: string) => {
      await authenticatedTestClient(token)
        .post(`/api/v1/sessions/${sessionId}/messages`)
        .send({ message: 'go' });
      const res = await authenticatedTestClient(token).post(
        `/api/v1/sessions/${sessionId}/generate?wait=true`
      );
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      return res;
    };

    test('a later turn replays the stored reasoning signatures', async () => {
      const sessionId = await createSession();
      const first = await turn(sessionId);
      const firstTurnSignatures = requestBodies.map((_body, index) => {
        return `sig_${index + 1}`;
      });

      const second = await turn(sessionId);

      const lastRequest = requestBodies[requestBodies.length - 1];
      expect(signaturesSent(lastRequest)).toEqual(
        expect.arrayContaining(firstTurnSignatures)
      );
      expectNoVendorOptions(first.body);
      expectNoVendorOptions(second.body);
    });

    test('a fork replays the parent turn signatures', async () => {
      const parentId = await createSession();
      await turn(parentId);
      const parentSignatures = requestBodies.map((_body, index) => {
        return `sig_${index + 1}`;
      });
      const fork = await authenticatedTestClient(token)
        .post(`/api/v1/sessions/${parentId}/fork`)
        .send({});
      expect(fork.status).toBe(201);

      await turn(fork.body.id);

      const lastRequest = requestBodies[requestBodies.length - 1];
      expect(signaturesSent(lastRequest)).toEqual(
        expect.arrayContaining(parentSignatures)
      );
    });
  });
});
