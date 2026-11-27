import createDebug from 'debug';

import {
  type AgentToolTurn,
  startAgentToolTurn,
} from '../../fixtures/agentToolTurn';
import {
  type ChatCompletionStub,
  startChatCompletionStub,
} from '../../fixtures/chatCompletionStub';

// What another party wrote reaches the caller where the contract puts it, and
// no line the process logs: the error log, the stored-error log and the tool
// resolver's debug log.

const MARKER = 'PATIENT-RECORD-7731';

describe('error logs carry no external content', () => {
  let turn: AgentToolTurn;
  let provider: ChatCompletionStub;
  let lines: string[];
  let previousNamespaces: string;
  const previousErrorLogsEnabled = process.env.SOAT_ERROR_LOGS_ENABLED;

  beforeAll(async () => {
    turn = await startAgentToolTurn({ prefix: 'errorlogcontent' });
    provider = await startChatCompletionStub({
      reply: () => {
        return { error: `refused: ${MARKER}` };
      },
    });
  });

  afterAll(async () => {
    await provider.close();
    await turn.close();
  });

  beforeEach(() => {
    turn.target.reset();
    delete process.env.SOAT_ERROR_LOGS_ENABLED;
    lines = [];
    const capture = (...parts: unknown[]) => {
      lines.push(
        parts
          .map((part) => {
            return typeof part === 'string' ? part : JSON.stringify(part);
          })
          .join(' ')
      );
    };
    for (const method of ['error', 'warn', 'log', 'info'] as const) {
      jest.spyOn(console, method).mockImplementation(capture);
    }
    previousNamespaces = createDebug.disable();
    createDebug.enable('soat:*');
    jest.spyOn(createDebug, 'log').mockImplementation(capture);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    createDebug.disable();
    createDebug.enable(previousNamespaces);
    if (previousErrorLogsEnabled === undefined) {
      delete process.env.SOAT_ERROR_LOGS_ENABLED;
    } else {
      process.env.SOAT_ERROR_LOGS_ENABLED = previousErrorLogsEnabled;
    }
  });

  const logged = (): string => {
    return lines.join('\n');
  };

  const call = (toolId: string, body: Record<string, unknown> = {}) => {
    return turn.api().post(`/api/v1/tools/${toolId}/call`).send(body);
  };

  test('an http target refusing with a body', async () => {
    const name = turn.unique('http');
    const tool = await turn.createTool({
      name,
      parameters: {
        type: 'object',
        properties: { record_id: { type: 'string' } },
      },
      execute: {
        url: `${turn.target.baseUrl}/${name}/{record_id}`,
        method: 'GET',
      },
    });
    turn.target.reply(`/${name}/${MARKER}-ID`, {
      status: 403,
      body: { code: 'denied', record: MARKER },
    });

    const res = await call(tool.id, { input: { record_id: `${MARKER}-ID` } });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('TOOL_HTTP_ERROR');
    expect(res.body.error.meta.tool_response_body).toContain(MARKER);
    expect(res.body.error.meta.tool_response_json.record).toBe(MARKER);
    expect(logged()).toContain('Request failed');
    expect(logged()).not.toContain(MARKER);
  });

  test('an mcp server reporting a failed call', async () => {
    const name = turn.unique('mcp');
    const tool = await turn.createTool({
      name,
      type: 'mcp',
      execute: undefined,
      parameters: undefined,
      mcp: { url: `${turn.target.baseUrl}/${name}` },
    });
    turn.target.reply(`/${name}`, (body) => {
      return {
        body: {
          jsonrpc: '2.0',
          id: body.id,
          result: {
            isError: true,
            content: [{ type: 'text', text: `no access to ${MARKER}` }],
          },
        },
      };
    });

    const res = await call(tool.id, { action: 'read_record', input: {} });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('MCP_TOOL_ERROR');
    expect(res.body.error.message).toContain(MARKER);
    expect(logged()).toContain('Request failed');
    expect(logged()).not.toContain(MARKER);
  });

  test('a provider answering an error body', async () => {
    const created = await turn
      .api()
      .post('/api/v1/ai-providers')
      .send({
        project_id: turn.projectId,
        name: turn.unique('failing-provider'),
        provider: 'ollama',
        default_model: 'stub-model',
        base_url: provider.baseUrl,
      });
    expect(created.status).toBe(201);
    const agentId = await turn.createAgent({ ai_provider_id: created.body.id });

    const res = await turn
      .api()
      .post(`/api/v1/agents/${agentId}/generate?wait=true`)
      .send({ messages: [{ role: 'user', content: 'hello' }] });

    expect(JSON.stringify(res.body)).toContain(MARKER);
    expect(logged()).toContain('AI_PROVIDER_ERROR');
    expect(logged()).not.toContain(MARKER);
  });
});
